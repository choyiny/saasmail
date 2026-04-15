/**
 * Replace {{variableName}} tokens with values from the variables object.
 * Unmatched tokens are left as-is.
 */
export function interpolate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return key in variables ? variables[key] : match;
  });
}
