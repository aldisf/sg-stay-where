// Singapore-first phone normalisation to WhatsApp's digits-only form.
export function normalizePhone(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 8 && /^[3689]/.test(digits)) return `65${digits}`;
  return digits.length >= 8 ? digits : null;
}

export function phoneFromJid(jid) {
  const m = String(jid ?? "").match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/);
  return m ? m[1] : null;
}

export function jidFromPhone(phone) {
  const digits = normalizePhone(phone);
  return digits ? `${digits}@s.whatsapp.net` : null;
}
