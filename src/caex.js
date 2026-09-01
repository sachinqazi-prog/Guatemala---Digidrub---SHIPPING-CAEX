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
 * Returns tomorrow's date as an ISO string, at a reasonable business
 * hour (9am). CAEX was rejecting requests with FechaRecoleccion set to
 * the current moment with "Poblados no se puede entregar en el mismo
 * dia" (can't deliver same-day) — happened consistently across
 * different towns and different TipoEntrega values, so the pickup DATE
 * itself (today) was the trigger, not the service type. Defaulting to
 * tomorrow avoids asking CAEX for same-day service at all.
 */
function tomorrowAt9am() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
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
 * This replaces an earlier version that (a) called this once per
 * order, (b) guessed at several field names/values never confirmed
 * against real documentation, and (c) sent an extra <TokenDireccion>
 * element that doesn't exist in CAEX's real schema at all. Every field
 * below is now mapped exactly to CAEX's spec — see the comment on each.
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
  cantidadPiezas,    // n — number of pieces for this product (from Cantidad_de_piezas)
  pesoTotalKg,       // total weight for this product; gets divided by n per CAEX's spec
}) {
  const recoleccionId = `${orderNumber}-${productNumber}`;
  const n = Math.max(1, Number(cantidadPiezas) || 1);
  const pesoPorPieza = (Number(pesoTotalKg) || 1) / n;

  const piezasXml = Array.from({ length: n }, (_, i) => `<tns:Pieza>
            <tns:NumeroPieza>${i + 1}</tns:NumeroPieza>
            <tns:TipoPieza>${escapeXml(process.env.CAEX_DEFAULT_PIEZA)}</tns:TipoPieza>
            <tns:PesoPieza>${pesoPorPieza}</tns:PesoPieza>
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

  const first = recolecciones[0] || {};

  return {
    success: true,
    recoleccionId,
    trackingNumber: first.NumeroGuia,
    // Per CAEX's spec: URLRecoleccion is the PDF with the generated
    // shipping label — this is what should be saved, not URLConsulta.
    trackingUrl: first.URLRecoleccion || null,
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
