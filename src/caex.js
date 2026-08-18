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

export async function generateGuide({
  codigoDespacho,
  customerName,
  phone,
  email,
  address1,
  address2,
  city,
  province,
  deptCode,
  destPobladoCode,
  reference,
  amount,
}) {
  // IMPORTANT:
  // Replace this XML with the real CAEX GenerarGuia template.
  const body = `<GenerarGuia xmlns="${CAEX_NS}">
      ${authXml()}
      <DatosGuia>
        <CodigoCredito>${process.env.CAEX_CREDITO}</CodigoCredito>
        <CodigoDespacho>${codigoDespacho}</CodigoDespacho>
        <CodigoPobladoOrigen>${process.env.CAEX_ORIGEN_POBLADO}</CodigoPobladoOrigen>
        <CodigoPobladoDestino>${destPobladoCode}</CodigoPobladoDestino>
        <NombreDestinatario>${escapeXml(customerName)}</NombreDestinatario>
        <TelefonoDestinatario>${escapeXml(phone)}</TelefonoDestinatario>
        <EmailDestinatario>${escapeXml(email)}</EmailDestinatario>
        <Direccion1>${escapeXml(address1)}</Direccion1>
        <Direccion2>${escapeXml(address2 || '')}</Direccion2>
        <Ciudad>${escapeXml(city)}</Ciudad>
        <Departamento>${escapeXml(province)}</Departamento>
        <Referencia>${escapeXml(reference)}</Referencia>
        <Valor>${escapeXml(String(amount || '0'))}</Valor>
      </DatosGuia>
    </GenerarGuia>`;

  const response = await soapCall('GenerarGuia', body);

  // IMPORTANT:
  // Adjust these paths after you get the real CAEX response example.
  const result = response?.ResultadoGenerarGuia || response;
  const opResult = result?.ResultadoOperacion;

  if (opResult?.ResultadoExitoso === true || opResult?.ResultadoExitoso === 'true') {
    return {
      success: true,
      trackingNumber:
        result?.NumeroGuia ||
        result?.Guia ||
        result?.TrackingNumber,
      trackingUrl:
        result?.UrlRastreo || null,
      raw: result,
    };
  }

  return {
    success: false,
    error: opResult?.MensajeError || 'Unknown CAEX GenerarGuia error',
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