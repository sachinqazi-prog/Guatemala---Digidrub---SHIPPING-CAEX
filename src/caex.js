/**
 * CAEX SOAP client.
 * Wraps the ugly XML dance behind clean async functions.
 */
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { log } from './logger.js';

const CAEX_NS = 'http://www.caexlogistics.com/ServiceBus';

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: true,
  trimValues: true,
});

/**
 * Low-level SOAP call. Returns parsed response body or throws.
 */
async function soapCall(operation, bodyXml) {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    ${bodyXml}
  </soap:Body>
</soap:Envelope>`;

  const url = process.env.CAEX_URL;
  const soapAction = `"${CAEX_NS}/${operation}"`;

  try {
    const { data } = await axios.post(url, envelope, {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': soapAction,
      },
      timeout: Number(process.env.CAEX_TIMEOUT_MS) || 8000,
    });

    const parsed = parser.parse(data);
    const body = parsed?.Envelope?.Body;
    if (!body) throw new Error('Malformed SOAP response');

    // Response keys look like "OperationResponse"
    const responseKey = Object.keys(body).find((k) => k.endsWith('Response'));
    return body[responseKey];
  } catch (err) {
    log.error(`CAEX ${operation} call failed`, err.message);
    throw err;
  }
}

/**
 * Authentication block reused in every call.
 */
function authXml() {
  return `<Autenticacion>
        <Login>${process.env.CAEX_LOGIN}</Login>
        <Password>${process.env.CAEX_PASSWORD}</Password>
      </Autenticacion>`;
}

/**
 * Get shipping rate for a single service type.
 * Returns { success: true, price, raw } or { success: false, error, code, raw }.
 */
export async function getRate({ origen, destino, pieza, servicio, peso }) {
  const body = `<ObtenerTarifaEnvio xmlns="${CAEX_NS}">
      ${authXml()}
      <DatosEnvio>
        <CodigoPobladoDestino>${destino}</CodigoPobladoDestino>
        <CodigoPieza>${pieza}</CodigoPieza>
        <TipoServicio>${servicio}</TipoServicio>
        <PesoTotal>${peso}</PesoTotal>
        <CodigoCredito>${process.env.CAEX_CREDITO}</CodigoCredito>
        <CodigoPobladoOrigen>${origen}</CodigoPobladoOrigen>
        <TipoEntrega>${process.env.CAEX_DEFAULT_ENTREGA}</TipoEntrega>
      </DatosEnvio>
    </ObtenerTarifaEnvio>`;

  const response = await soapCall('ObtenerTarifaEnvio', body);
  const result = response?.ResultadoObtenerTarifa;
  const opResult = result?.ResultadoOperacion;

  if (opResult?.ResultadoExitoso === true || opResult?.ResultadoExitoso === 'true') {
    return {
      success: true,
      price: parseFloat(result.MontoTarifa),
      origen: result.Origen,
      destino: result.Destino,
      peso: result.Peso,
      servicio,
    };
  }

  return {
    success: false,
    error: opResult?.MensajeError || 'Unknown CAEX error',
    code: opResult?.CodigoRespuesta,
    servicio,
  };
}

/**
 * Get all 22 departments. Used by fetch-all-poblados script.
 */
export async function getDepartamentos() {
  const body = `<ObtenerListadoDepartamentos xmlns="${CAEX_NS}">
      ${authXml()}
    </ObtenerListadoDepartamentos>`;

  const response = await soapCall('ObtenerListadoDepartamentos', body);
  const list = response?.ResultadoObtenerDepartamentos?.ListadoDepartamentos?.Departamento;
  return Array.isArray(list) ? list : list ? [list] : [];
}

/**
 * Get all poblados in a department.
 */
export async function getPoblados(codigoDepartamento) {
  const body = `<ObtenerListadoPoblados xmlns="${CAEX_NS}">
      ${authXml()}
      <CodigoDepartamento>${codigoDepartamento}</CodigoDepartamento>
    </ObtenerListadoPoblados>`;

  const response = await soapCall('ObtenerListadoPoblados', body);
  const list = response?.ResultadoObtenerPoblados?.ListadoPoblados?.Poblado;
  return Array.isArray(list) ? list : list ? [list] : [];
}

/**
 * Generate ONE shipping guide for ONE invoiced line item.
 *
 * Per CAEX's own official spec (PDF supplied by CAEX support,
 * "Explanation of the GenerarGuia method"): GenerarGuia must be called
 * ONCE PER INVOICED PRODUCT, not once per order. If an order has 2+
 * products, call this function 2+ times — see order-paid-handler.js's
 * processGuideGeneration for the loop.
 *
 * IMPORTANT (confirmed via real order #1143, 3-unit line item):
 * when cantidadPiezas > 1, CAEX does NOT return a single guide
 * covering all pieces. It returns ONE SEPARATE DatosRecoleccion per
 * piece, each with its own NumeroGuia/URLRecoleccion/URLConsulta —
 * i.e. n physically separate labeled shipments for n pieces of the
 * same product. An earlier version of this function kept only
 * `recolecciones[0]`, silently discarding tracking numbers for every
 * piece beyond the first. This version returns ALL of them — callers
 * (order-paid-handler.js / shopify.js) are responsible for attaching
 * every tracking number to the Shopify fulfillment, not just one.
 */
export async function generateGuide({
  orderNumber,       // Shopify order number, e.g. "202601"
  productNumber,     // Invoiced product number within the order, e.g. "01"
  customerName,      // Point 2: Nombre + Apellido from Shipping Details
  address1,          // Point 3: "Dirección de Calle" field only
  phone,             // Point 4
  nit,               // Point 5: real customer NIT from FEL/invoice data (NOT "CF" — see caller)
  sku,               // for Point 6
  productName,       // for Point 6
  invoiceUuid,       // Point 7: the FEL invoice UUID
  destPobladoCode,   // Point 8: CAEX poblado code for the destination
  cantidadPiezas,    // n — TOTAL <Pieza> entries for this line item (piecesPerUnit × quantity)
  piecesPerUnit,     // how many physical boxes ONE UNIT ships as — used ONLY to divide weight, never affected by quantity
  pesoTotalKg,       // weight of ONE UNIT (from Shopify's per-unit grams field, NOT multiplied by quantity)
}) {
  const recoleccionId = `${orderNumber}-${productNumber}`;
  const n = Math.max(1, Number(cantidadPiezas) || 1);

  // CAEX's GenerarGuia field is PesoPieza, and the printed labels
  // confirm it's treated as LBS with no conversion of its own — a
  // real order (#1146) sent 71.21 (meant as kg, from Shopify's grams
  // field converted to kg) and the label printed "71.21 lbs" verbatim,
  // understating the bed's real ~157lb weight by roughly half. Since
  // pesoTotalKg arrives here in KILOGRAMS (converted from Shopify's
  // grams field in order-paid-handler.js), it must be converted to
  // pounds here before being divided/sent, or every real-weight label
  // silently shows the wrong unit.
  const KG_TO_LBS = 2.20462;
  const pesoTotalLbs = (Number(pesoTotalKg) || 0) * KG_TO_LBS;

  // IMPORTANT: weight divides by piecesPerUnit (how many boxes ONE
  // UNIT physically ships as), NOT by n (which also folds in the
  // quantity multiplier). pesoTotalKg is already the weight of a
  // SINGLE unit — it was never multiplied by quantity — so dividing
  // it by n would halve (or worse) the real per-piece weight anytime
  // quantity > 1. Real case caught on order #1152: two identical
  // 159lb dining sets (quantity=2, no known sub-boxing so
  // piecesPerUnit defaults to 1, n=2 via the quantity fallback) were
  // each labeled 79.50 lbs instead of their real 159.00 lbs each —
  // one unit's weight was being split BETWEEN the two separate units
  // instead of each unit keeping its own full weight. Pieces within
  // the SAME unit's sub-boxing split that one unit's weight; every
  // additional unit in the order repeats that same per-piece weight,
  // not a further fraction of it.
  const effectivePiecesPerUnit = Math.max(1, Number(piecesPerUnit) || 1);
  const pesoPorPieza = pesoTotalLbs / effectivePiecesPerUnit; // 0 stays 0 — no fake fallback

  const piezasXml = Array.from({ length: n }, (_, i) => `<tns:Pieza>
            <tns:NumeroPieza>${i + 1}</tns:NumeroPieza>
            <tns:TipoPieza>${escapeXml(process.env.CAEX_DEFAULT_PIEZA)}</tns:TipoPieza>
            <tns:PesoPieza>${pesoPorPieza.toFixed(2)}</tns:PesoPieza>
            <tns:MontoCOD>0.00</tns:MontoCOD>
          </tns:Pieza>`).join('\n          ');

  const bodyXml = `<tns:GenerarGuia xmlns:tns="${CAEX_NS}">
      <tns:Autenticacion>
        <tns:Login>${escapeXml(process.env.CAEX_LOGIN)}</tns:Login>
        <tns:Password>${escapeXml(process.env.CAEX_PASSWORD)}</tns:Password>
      </tns:Autenticacion>
      <tns:ListaRecolecciones>
        <tns:DatosRecoleccion>
          <tns:RecoleccionID>${escapeXml(recoleccionId)}</tns:RecoleccionID>
          <tns:RemitenteNombre>${escapeXml(process.env.CAEX_REMITENTE_NOMBRE)}</tns:RemitenteNombre>
          <tns:RemitenteDireccion>${escapeXml(process.env.CAEX_REMITENTE_DIRECCION)}</tns:RemitenteDireccion>
          <tns:RemitenteTelefono>${escapeXml(process.env.CAEX_REMITENTE_TELEFONO)}</tns:RemitenteTelefono>
          <tns:DestinatarioNombre>${escapeXml(customerName)}</tns:DestinatarioNombre>
          <tns:DestinatarioDireccion>${escapeXml(address1)}</tns:DestinatarioDireccion>
          <tns:DestinatarioTelefono>${escapeXml(phone)}</tns:DestinatarioTelefono>
          <tns:DestinatarioContacto>${escapeXml(recoleccionId)}</tns:DestinatarioContacto>
          <tns:DestinatarioNIT>${escapeXml(nit || 'CF')}</tns:DestinatarioNIT>
          <tns:ReferenciaCliente1>${escapeXml(`${sku || ''} - ${productName || ''}`)}</tns:ReferenciaCliente1>
          <tns:ReferenciaCliente2>${escapeXml(invoiceUuid || '')}</tns:ReferenciaCliente2>
          <tns:CodigoPobladoDestino>${escapeXml(destPobladoCode)}</tns:CodigoPobladoDestino>
          <tns:CodigoPobladoOrigen>${escapeXml(process.env.CAEX_ORIGEN_POBLADO)}</tns:CodigoPobladoOrigen>
          <tns:TipoServicio>${escapeXml(process.env.CAEX_DEFAULT_SERVICIO)}</tns:TipoServicio>
          <tns:MontoCOD>0.00</tns:MontoCOD>
          <tns:FormatoImpresion>1</tns:FormatoImpresion>
          <tns:CodigoCredito>${escapeXml(process.env.CAEX_CREDITO)}</tns:CodigoCredito>
          <tns:MontoAsegurado>0.00</tns:MontoAsegurado>
          <tns:Observaciones>Entrega regular</tns:Observaciones>
          <tns:TipoEntrega>${escapeXml(process.env.CAEX_DEFAULT_ENTREGA)}</tns:TipoEntrega>
          <tns:Piezas>
          ${piezasXml}
          </tns:Piezas>
        </tns:DatosRecoleccion>
      </tns:ListaRecolecciones>
    </tns:GenerarGuia>`;

  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    ${bodyXml}
  </soap:Body>
</soap:Envelope>`;

  log.info('CAEX GenerarGuia outgoing request', envelope);

  const url = process.env.CAEX_URL;
  const soapAction = `"${CAEX_NS}/GenerarGuia"`;
  let data;
  try {
    ({ data } = await axios.post(url, envelope, {
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': soapAction,
      },
      timeout: Number(process.env.CAEX_TIMEOUT_MS) || 8000,
    }));
  } catch (err) {
    log.error('CAEX GenerarGuia call failed', err.message);
    throw err;
  }

  log.info('CAEX GenerarGuia raw response', data);
  const parsed = parser.parse(data);
  const response = parsed?.Envelope?.Body?.GenerarGuiaResponse;

  const result = response?.ResultadoGenerarGuia;
  const opResult = result?.ResultadoOperacionMultiple;

  if (!(opResult?.ResultadoExitoso === true || opResult?.ResultadoExitoso === 'true')) {
    return {
      success: false,
      error: opResult?.MensajeError || 'Unknown CAEX GenerarGuia error',
      code: opResult?.CodigoRespuesta,
      raw: result,
    };
  }

  let recolecciones = result?.ListaRecolecciones?.DatosRecoleccion;
  recolecciones = Array.isArray(recolecciones) ? recolecciones : recolecciones ? [recolecciones] : [];

  if (recolecciones.length === 0) {
    return {
      success: false,
      error: 'CAEX reported success but returned no DatosRecoleccion entries',
      raw: result,
    };
  }

  // One entry per PIECE, not per product — e.g. cantidadPiezas=3 returns
  // 3 entries here, each a separately labeled/tracked CAEX shipment.
  const pieces = recolecciones.map((r) => ({
    numeroPieza: r.NumeroPieza,
    trackingNumber: r.NumeroGuia,
    // Per CAEX's spec: URLRecoleccion is the PDF with the generated
    // shipping label — this is what should be saved, not URLConsulta.
    trackingUrl: r.URLRecoleccion || null,
  }));

  return {
    success: true,
    recoleccionId,
    // Backward-compatible single values (first piece) — some older
    // callers may still read these directly. New code should use
    // `pieces` to get every tracking number/URL when n > 1.
    trackingNumber: pieces[0].trackingNumber,
    trackingUrl: pieces[0].trackingUrl,
    pieces,
    raw: result,
  };
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
