/**
 * Splits an RFC 5233 subaddress: `local+detail@domain` gives
 * `{ base: "local@domain", detail: "detail" }` (the first `+` of the local
 * part; the detail may hold more). Anything else, an empty detail included,
 * comes back whole with a null detail. Expects a lowercased address.
 */
export function splitSubaddress(address: string): {
  base: string;
  detail: string | null;
} {
  const at = address.lastIndexOf("@");
  if (at <= 0) return { base: address, detail: null };
  const local = address.slice(0, at);
  const plus = local.indexOf("+");
  if (plus <= 0) return { base: address, detail: null };
  const detail = local.slice(plus + 1);
  if (detail === "") return { base: address, detail: null };
  return { base: `${local.slice(0, plus)}${address.slice(at)}`, detail };
}
