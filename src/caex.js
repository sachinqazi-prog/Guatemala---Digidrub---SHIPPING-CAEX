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
 * Build a single <Pieza> node for the Piezas list.
 * CAEX doesn't publish the internal Pieza schema in the public op docs
 * (it shows as xsi:nil in the sample). Field names below are a best
 * guess based on CAEX's naming conventions elsewhere in the WSDL, plus
 * the CodigoPieza value we already know is real (used successfully in
 * ObtenerTarifaEnvio via CAEX_DEFAULT_PIEZA). NOT CONFIRMED — if CAEX
 * rejects the request specifically on a Pieza field, that's the first
 * place to check; ask CAEX support for a working GenerarGuia example
 * with real Piezas if this turns out to be wrong.
 */
function piezaXml({ peso, alto, ancho, largo, valorDeclarado, descripcion, codigoPieza } = {}) {
  return `<Pieza>
        <CodigoPieza>${escapeXml(codigoPieza || process.env.CAEX_DEFAULT_PIEZA)}</CodigoPieza>
        <Peso>${peso ?? 1}</Peso>
        <Alto>${alto ?? 1}</Alto>
        <Ancho>${ancho ?? 1}</Ancho>
        <Largo>${largo ?? 1}</Largo>
        <ValorDeclarado>${valorDeclarado ?? 0}</ValorDeclarado>
        <Descripcion>${descripcion ? escapeXml(descripcion) : 'Mercaderia'}</Descripcion>
      </Pieza>`;
}

/**
 * Generate a shipping guide via GenerarGuia.
 *
 * Accepts the SAME shape that order-paid-handler.js's buildGuidePayload()
 * already produces, so the caller needs no changes:
 *   { orderId, codigoDespacho, customerName, phone, email, address1,
 *     address2, city, province, deptCode, destPobladoCode, reference, amount }
 *
 * Internally this maps that payload onto CAEX's real GenerarGuia schema —
 * ListaRecolecciones > DatosRecoleccion — filling in fields the handler
 * doesn't send (sender/shipper info, package pieces) from env vars and
 * sane defaults.
 *
 * Known gaps, flagged rather than silently guessed:
 * - `TokenDireccion`: no confirmed source yet. Sent empty. If CAEX starts
 *   rejecting requests, check the full operations list at
 *   https://ws.caexlogistics.com/wsCAEXLogisticsSB/wsCAEXLogisticsSB.asmx
 *   for an address-validation/tokenization op that must run first.
 * - `Piezas` (package weight/dims): this handler doesn't currently pass
 *   real package data, so a single default piece is sent using
 *   CAEX_DEFAULT_PIEZA and placeholder weight/dimensions. If CAEX needs
 *   accurate weight for routing/pricing, `order-paid-handler.js` should
 *   be extended to pass `piezas` built from `order.line_items[].grams`.
 * - `DestinatarioNIT`: this handler has no NIT data (that lives in the
 *   separate certification service per earlier findings), so 'CF' is
 *   sent. Confirm with CAEX whether 'CF' is an acceptable placeholder
 *   for guide generation specifically (separate from invoicing).
 */
export async function generateGuide({
  orderId,
  customerName,
  phone,
  address1,
  address2,
  destPobladoCode,
  reference,
  amount,
  piezas,
}) {
  const direccionCompleta = [address1, address2].filter(Boolean).join(', ');
  const recoleccionId = String(reference || orderId || '');

  const piezasArray = Array.isArray(piezas) && piezas.length > 0 ? piezas : [{}];
  const piezasXml = piezasArray.map(piezaXml).join('\n        ');

  const datosRecoleccionXml = `<DatosRecoleccion>
        <RecoleccionID>${escapeXml(recoleccionId)}</RecoleccionID>
        <RemitenteNombre>${escapeXml(process.env.CAEX_REMITENTE_NOMBRE)}</RemitenteNombre>
        <RemitenteDireccion>${escapeXml(process.env.CAEX_REMITENTE_DIRECCION)}</RemitenteDireccion>
        <RemitenteTelefono>${escapeXml(process.env.CAEX_REMITENTE_TELEFONO)}</RemitenteTelefono>
        <DestinatarioNombre>${escapeXml(customerName)}</DestinatarioNombre>
        <DestinatarioDireccion>${escapeXml(direccionCompleta)}</DestinatarioDireccion>
        <DestinatarioTelefono>${escapeXml(phone)}</DestinatarioTelefono>
        <DestinatarioContacto>${escapeXml(customerName)}</DestinatarioContacto>
        <DestinatarioNIT>CF</DestinatarioNIT>
        <ReferenciaCliente1>${escapeXml(reference)}</ReferenciaCliente1>
        <ReferenciaCliente2>${escapeXml(String(orderId || ''))}</ReferenciaCliente2>
        <CodigoPobladoDestino>${escapeXml(destPobladoCode)}</CodigoPobladoDestino>
        <CodigoPobladoOrigen>${escapeXml(process.env.CAEX_ORIGEN_POBLADO)}</CodigoPobladoOrigen>
        <TipoServicio>${escapeXml(process.env.CAEX_DEFAULT_SERVICIO)}</TipoServicio>
        <MontoCOD>0</MontoCOD>
        <FormatoImpresion>${escapeXml(process.env.CAEX_FORMATO_IMPRESION || 'PDF')}</FormatoImpresion>
        <CodigoCredito>${escapeXml(process.env.CAEX_CREDITO)}</CodigoCredito>
        <MontoAsegurado>${parseFloat(amount) || 0}</MontoAsegurado>
        <Observaciones></Observaciones>
        <CodigoReferencia>0</CodigoReferencia>
        <FechaRecoleccion>${new Date().toISOString()}</FechaRecoleccion>
        <TipoEntrega>${escapeXml(process.env.CAEX_DEFAULT_ENTREGA)}</TipoEntrega>
        <TokenDireccion></TokenDireccion>
        <Piezas>
        ${piezasXml}
        </Piezas>
      </DatosRecoleccion>`;

  const body = `<GenerarGuia xmlns="${CAEX_NS}">
      ${authXml()}
      <ListaRecolecciones>
        ${datosRecoleccionXml}
      </ListaRecolecciones>
    </GenerarGuia>`;

  const response = await soapCall('GenerarGuia', body);

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

  // Per-item results — each recoleccion has its own ResultadoOperacion.
  const items = recolecciones.map((r) => ({
    recoleccionId: r.RecoleccionID,
    piezaNumero: r.NumeroPieza,
    trackingNumber: r.NumeroGuia,
    rate: r.MontoTarifa != null ? parseFloat(r.MontoTarifa) : null,
    trackingUrl: r.URLConsulta || null,
    pickupUrl: r.URLRecoleccion || null,
    success:
      r?.ResultadoOperacion?.ResultadoExitoso === true ||
      r?.ResultadoOperacion?.ResultadoExitoso === 'true',
    error: r?.ResultadoOperacion?.MensajeError || null,
  }));

  const first = items[0] || {};

  return {
    success: true,
    // Convenience top-level fields for the common single-order case:
    trackingNumber: first.trackingNumber,
    trackingUrl: first.trackingUrl,
    // Full list, in case multiple recolecciones/piezas were sent:
    items,
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
