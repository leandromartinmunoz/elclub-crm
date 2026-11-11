// Exact, account-scoped aliases for Meta's test recipient allowlist only.
// Never infer Argentine area-code boundaries or modify the stored contact identity.
export function whatsappTestRecipient(accountId: string, contactPhone: string,
  configuration = process.env.WHATSAPP_TEST_RECIPIENT_ALIASES): string {
  if (!configuration?.trim()) return contactPhone;
  let aliases: unknown;
  try { aliases = JSON.parse(configuration); }
  catch { throw new Error("WHATSAPP_TEST_RECIPIENT_ALIASES debe ser una lista JSON válida."); }
  if (!Array.isArray(aliases)) throw new Error("WHATSAPP_TEST_RECIPIENT_ALIASES debe ser una lista JSON.");
  const seen = new Set<string>();
  let recipient = contactPhone;
  for (const alias of aliases) {
    if (!alias || typeof alias !== "object"
      || ![alias.accountId, alias.contactPhone, alias.recipientPhone].every(
        value => typeof value === "string" && /^\d{5,20}$/.test(value)))
      throw new Error("Cada equivalencia de prueba debe contener accountId, contactPhone y recipientPhone válidos.");
    const key = `${alias.accountId}:${alias.contactPhone}`;
    if (seen.has(key)) throw new Error("Hay equivalencias de destinatario de prueba duplicadas.");
    seen.add(key);
    if (alias.accountId === accountId && alias.contactPhone === contactPhone) recipient = alias.recipientPhone;
  }
  return recipient;
}
