/**
 * Shopify sends Guatemalan addresses with ISO 3166-2:GT province codes.
 * CAEX uses its own 2-digit department codes (01-22).
 * This maps one to the other.
 *
 * Shopify may send either:
 *   - province_code: "GT" (country only) — rare
 *   - province_code: "GT-GU" or just "GU" (depends on version)
 *   - province: "Guatemala" or "Guatemala City" (full name) — most common fallback
 *
 * We handle all three cases.
 */

// Shopify ISO code (2-letter) → CAEX department code
export const ISO_TO_CAEX = {
  AV: '01', // Alta Verapaz
  BV: '02', // Baja Verapaz
  CM: '03', // Chimaltenango
  CQ: '04', // Chiquimula
  PR: '05', // El Progreso
  ES: '06', // Escuintla
  GU: '07', // Guatemala
  HU: '08', // Huehuetenango
  IZ: '09', // Izabal
  JA: '10', // Jalapa
  JU: '11', // Jutiapa
  PE: '12', // Petén
  QZ: '13', // Quetzaltenango
  QC: '14', // Quiché
  RE: '15', // Retalhuleu
  SA: '16', // Sacatepéquez
  SM: '17', // San Marcos
  SR: '18', // Santa Rosa
  SO: '19', // Sololá
  SU: '20', // Suchitepéquez
  TO: '21', // Totonicapán
  ZA: '22', // Zacapa
};

// Department name (normalized) → CAEX department code
// Covers full names, 3-letter abbreviations, and variants Shopify may send
export const NAME_TO_CAEX = {
  // Alta Verapaz
  'alta verapaz': '01', ave: '01', 'alta v': '01',
  // Baja Verapaz
  'baja verapaz': '02', bve: '02', bav: '02', 'baja v': '02',
  // Chimaltenango
  chimaltenango: '03', chi: '03', chm: '03',
  // Chiquimula
  chiquimula: '04', chq: '04',
  // El Progreso
  'el progreso': '05', progreso: '05', pro: '05', epr: '05',
  // Escuintla
  escuintla: '06', esc: '06',
  // Guatemala
  guatemala: '07', gua: '07', gt: '07',
  // Huehuetenango
  huehuetenango: '08', hue: '08',
  // Izabal
  izabal: '09', iza: '09',
  // Jalapa
  jalapa: '10', jal: '10',
  // Jutiapa
  jutiapa: '11', jut: '11',
  // Petén
  peten: '12', petén: '12', pet: '12',
  // Quetzaltenango
  quetzaltenango: '13', que: '13', qtz: '13', qzt: '13',
  // Quiché
  quiche: '14', quiché: '14', qui: '14', quc: '14',
  // Retalhuleu
  retalhuleu: '15', ret: '15',
  // Sacatepéquez
  sacatepequez: '16', sacatepéquez: '16', sac: '16',
  // San Marcos
  'san marcos': '17', sma: '17', smr: '17',
  // Santa Rosa
  'santa rosa': '18', sro: '18', sra: '18',
  // Sololá
  solola: '19', sololá: '19', sol: '19',
  // Suchitepéquez
  suchitepequez: '20', suchitepéquez: '20', suc: '20',
  // Totonicapán
  totonicapan: '21', totonicapán: '21', tot: '21',
  // Zacapa
  zacapa: '22', zac: '22',
};

/**
 * Best-effort resolve of a Shopify address's province → CAEX department code.
 * Returns the 2-digit CAEX code or null if unresolvable.
 */
export function resolveDepartamento({ province, province_code }) {
  // Try ISO code first (cleanest)
  if (province_code) {
    const code = province_code.toUpperCase().replace(/^GT-?/, '');
    if (ISO_TO_CAEX[code]) return ISO_TO_CAEX[code];
  }

  // Fall back to name match
  if (province) {
    const normalized = province
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // strip accents for the lookup but keep accented keys too
      .trim();
    if (NAME_TO_CAEX[normalized]) return NAME_TO_CAEX[normalized];

    // Also try raw (with accents) in case it matches
    const raw = province.toLowerCase().trim();
    if (NAME_TO_CAEX[raw]) return NAME_TO_CAEX[raw];
  }

  return null;
}
