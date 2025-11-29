function escapeXml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isBooleanLike(val) {
  if (val === true || val === false) return true;
  const s = String(val).trim().toLowerCase();
  return ['true','false','1','0','так','ні','да','нет'].includes(s);
}

function booleanToUa(val) {
  if (val === true) return 'Так';
  const s = String(val).trim().toLowerCase();
  if (['true','1','так','да'].includes(s)) return 'Так';
  if (['false','0','ні','нет'].includes(s)) return 'Ні';
  return '';
}

function normalizeDecimalWithUnit(rawValue, units) {
  if (rawValue === null || rawValue === undefined) return null;
  let s = String(rawValue).trim();
  if (!s) return null;
  // if units provided replace comma with dot
  if (units) s = s.replace(/,/g, '.');
  return s;
}

function convertLengthToCm(rawValue, units) {
  const s = normalizeDecimalWithUnit(rawValue, units);
  if (s === null) return '';
  const num = parseFloat(s);
  if (isNaN(num)) return '';
  const u = (units || '').toString().toLowerCase().trim();
  let out = num;
  if (u === 'мм' || u === 'mm') out = num / 10;
  else if (u === 'м' || u === 'm') out = num * 100;
  // 'см' or others -> keep
  // round to 2 decimals
  out = Math.round(out * 100) / 100;
  return out.toString();
}

function convertWeightToKg(rawValue, units) {
  const s = normalizeDecimalWithUnit(rawValue, units);
  if (s === null) return '';
  const num = parseFloat(s);
  if (isNaN(num)) return '';
  const u = (units || '').toString().toLowerCase().trim();
  let out = num;
  if (u === 'г' || u === 'g') out = num / 1000;
  // kg -> keep
  out = Math.round(out * 100) / 100;
  return out.toString();
}

module.exports = {
  escapeXml,
  isBooleanLike,
  booleanToUa,
  normalizeDecimalWithUnit,
  convertLengthToCm,
  convertWeightToKg
};
