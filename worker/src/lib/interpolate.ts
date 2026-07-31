const VARIABLE_REGEX = /\{\{(\w+)\}\}/g;

/**
 * Extract unique variable names from a template string.
 */
export function extractVariables(template: string): string[] {
  const vars = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = VARIABLE_REGEX.exec(template)) !== null) {
    vars.add(match[1]);
  }
  return Array.from(vars);
}

/**
 * Replace {{variableName}} tokens with values from the variables object.
 * Unmatched tokens are left as-is.
 */
export function interpolate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(VARIABLE_REGEX, (match, key) => {
    return key in variables ? variables[key] : match;
  });
}

export type RenderTemplateResult =
  | { ok: true; subject: string; bodyHtml: string }
  | { ok: false; missingVariables: string[]; requiredVariables: string[] };

/**
 * Validate that every variable a template references was supplied, then
 * interpolate its subject and body.
 *
 * Missing variables are reported rather than silently left as `{{token}}`
 * so callers can fail the send instead of mailing a half-rendered template.
 */
export function renderTemplate(
  template: { subject: string; bodyHtml: string },
  variables: Record<string, string>,
): RenderTemplateResult {
  const subjectVars = extractVariables(template.subject);
  const bodyVars = extractVariables(template.bodyHtml);
  const requiredVariables = Array.from(new Set([...subjectVars, ...bodyVars]));
  const missingVariables = requiredVariables.filter((v) => !(v in variables));

  if (missingVariables.length > 0) {
    return { ok: false, missingVariables, requiredVariables };
  }

  return {
    ok: true,
    subject: interpolate(template.subject, variables),
    bodyHtml: interpolate(template.bodyHtml, variables),
  };
}
