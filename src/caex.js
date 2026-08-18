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
 * (it shows as xsi:nil in the sample), so this uses the same field names
 * as ObtenerTarifaEnvio's package-level inputs. CONFIRM against a real
 * CAEX response/support ticket before relying on this in production —
 * if CAEX rejects it, ask their support for a working Pieza example.
 */
function piezaXml({ peso, alto, ancho, largo, valorDeclarado, descripcion }) {
  return `<Pieza>
        <Peso>${peso ?? 1}</Peso>
        <Alto>${alto ?? 1}</Alto>
        <Ancho>${ancho ?? 1}</Ancho>
        <Largo>${largo ?? 1}</Largo>
        <ValorDeclarado>${valorDeclarado ?? 0}</ValorDeclarado>
        <Descripcion>${descripcion ? escapeXml(descripcion) : 'Mercaderia'}</Descripcion>
      </Pieza>`;
}

/**
 * Generate one or more shipping guides via GenerarGuia.
 *
 * CAEX's GenerarGuia takes a LIST of recolecciones (pickups), each of
 * which can contain multiple Piezas (packages). This wraps a single
 * order into that shape. Pass `recolecciones: [...]` directly if you
 * ever need to batch multiple orders in one call.
 *
 * Required-looking fields per CAEX's published schema:
 *   RecoleccionID, RemitenteNombre/Direccion/Telefono,
 *   DestinatarioNombre/Direccion/Telefono, CodigoPobladoOrigen/Destino,
 *   TipoServicio, CodigoCredito, TipoEntrega, FechaRecoleccion, Piezas
 *
 * `TokenDireccion` shows up in CAEX's schema but there's no confirmed
 * source for it yet in this integration — it likely comes from a
 * separate address-validation/tokenization operation on the CAEX WSDL.
 * Sending it empty for now; if CAEX starts rejecting requests for this
 * reason, check the full operations list at
 * https://ws.caexlogistics.com/wsCAEXLogisticsSB/wsCAEXLogisticsSB.asmx
 * for an address-token operation and call it first.
 */
export async function generateGuide({
  recoleccionId,
  remitenteNombre,
  remitenteDireccion,
  remitenteTelefono,
  customerName,
  phone,
  address1,
  address2,
  nit,
  reference,
  referencia2,
  destPobladoCode,
  origenPobladoCode,
  servicio,
  montoCOD,
  formatoImpresion,
  montoAsegurado,
  observaciones,
  codigoReferencia,
  fechaRecoleccion,
  tipoEntrega,
  tokenDireccion,
  piezas,
}) {
  const direccionCompleta = [address1, address2].filter(Boolean).join(', ');

  const piezasArray = Array.isArray(piezas) && piezas.length > 0 ? piezas : [{}];
  const piezasXml = piezasArray.map(piezaXml).join('\n        ');

  const datosRecoleccionXml = `<DatosRecoleccion>
        <RecoleccionID>${escapeXml(recoleccionId)}</RecoleccionID>
        <RemitenteNombre>${escapeXml(remitenteNombre || process.env.CAEX_REMITENTE_NOMBRE)}</RemitenteNombre>
        <RemitenteDireccion>${escapeXml(remitenteDireccion || process.env.CAEX_REMITENTE_DIRECCION)}</RemitenteDireccion>
        <RemitenteTelefono>${escapeXml(remitenteTelefono || process.env.CAEX_REMITENTE_TELEFONO)}</RemitenteTelefono>
        <DestinatarioNombre>${escapeXml(customerName)}</DestinatarioNombre>
        <DestinatarioDireccion>${escapeXml(direccionCompleta)}</DestinatarioDireccion>
        <DestinatarioTelefono>${escapeXml(phone)}</DestinatarioTelefono>
        <DestinatarioContacto>${escapeXml(customerName)}</DestinatarioContacto>
        <DestinatarioNIT>${escapeXml(nit || 'CF')}</DestinatarioNIT>
        <ReferenciaCliente1>${escapeXml(reference)}</ReferenciaCliente1>
        <ReferenciaCliente2>${escapeXml(referencia2 || '')}</ReferenciaCliente2>
        <CodigoPobladoDestino>${escapeXml(destPobladoCode)}</CodigoPobladoDestino>
        <CodigoPobladoOrigen>${escapeXml(origenPobladoCode || process.env.CAEX_ORIGEN_POBLADO)}</CodigoPobladoOrigen>
        <TipoServicio>${escapeXml(servicio || process.env.CAEX_DEFAULT_SERVICIO)}</TipoServicio>
        <MontoCOD>${montoCOD ?? 0}</MontoCOD>
        <FormatoImpresion>${escapeXml(formatoImpresion || process.env.CAEX_FORMATO_IMPRESION || 'PDF')}</FormatoImpresion>
        <CodigoCredito>${escapeXml(process.env.CAEX_CREDITO)}</CodigoCredito>
        <MontoAsegurado>${montoAsegurado ?? 0}</MontoAsegurado>
        <Observaciones>${escapeXml(observaciones || '')}</Observaciones>
        <CodigoReferencia>${codigoReferencia ?? 0}</CodigoReferencia>
        <FechaRecoleccion>${fechaRecoleccion || new Date().toISOString()}</FechaRecoleccion>
        <TipoEntrega>${tipoEntrega ?? process.env.CAEX_DEFAULT_ENTREGA}</TipoEntrega>
        <TokenDireccion>${escapeXml(tokenDireccion || '')}</TokenDireccion>
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
