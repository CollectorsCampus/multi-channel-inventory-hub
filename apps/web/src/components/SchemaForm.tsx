/**
 * Renders a settings form from a connector's JSON Schema (§5).
 *
 * This is what lets a community connector ship a real configuration UI without
 * touching core code. It deliberately supports only the subset the server also
 * validates — object schemas with scalar properties — so the form and the
 * validator cannot disagree about what a connector may declare.
 */

export interface JsonSchemaProperty {
  type?: string;
  title?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  pattern?: string;
  minimum?: number;
  maximum?: number;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export function SchemaForm({
  schema,
  value,
  onChange,
  idPrefix,
}: {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  idPrefix: string;
}) {
  const properties = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);

  if (properties.length === 0) {
    return <p className="muted">This connector has no settings.</p>;
  }

  return (
    <div className="schema-form">
      {properties.map(([field, property]) => {
        const id = `${idPrefix}-${field}`;
        const current = value[field];

        return (
          <div key={field} className="schema-field">
            <label htmlFor={id}>
              {property.title ?? field}
              {required.has(field) && (
                <span aria-hidden className="req">
                  {' '}
                  *
                </span>
              )}
            </label>

            {property.enum ? (
              <select
                id={id}
                value={String(current ?? '')}
                required={required.has(field)}
                onChange={(e) => onChange({ ...value, [field]: e.target.value })}
              >
                <option value="">Choose…</option>
                {property.enum.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : property.type === 'boolean' ? (
              <input
                id={id}
                type="checkbox"
                checked={Boolean(current)}
                onChange={(e) => onChange({ ...value, [field]: e.target.checked })}
              />
            ) : property.type === 'number' || property.type === 'integer' ? (
              <input
                id={id}
                type="number"
                value={current === undefined || current === null ? '' : String(current)}
                required={required.has(field)}
                min={property.minimum}
                max={property.maximum}
                step={property.type === 'integer' ? 1 : 'any'}
                onChange={(e) =>
                  onChange({
                    ...value,
                    // Empty means "unset", not zero — sending 0 would silently
                    // configure something the operator left blank.
                    [field]: e.target.value === '' ? undefined : Number(e.target.value),
                  })
                }
              />
            ) : (
              <input
                id={id}
                type="text"
                value={current === undefined || current === null ? '' : String(current)}
                required={required.has(field)}
                // The server validates this too; the browser hint is a
                // convenience, not the guarantee.
                pattern={property.pattern}
                onChange={(e) => onChange({ ...value, [field]: e.target.value })}
              />
            )}

            {property.description && <p className="field-hint">{property.description}</p>}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Inputs for a connector's declared secret fields.
 *
 * Separate from SchemaForm because secrets are never part of `configSchema` —
 * the SDK's contract suite actively fails a connector that puts one there.
 * Existing values are never sent to the browser, so a field that is already set
 * shows a placeholder and submits only if the operator types a replacement.
 */
export function SecretFields({
  fields,
  alreadySet,
  optional = [],
  hints = {},
  value,
  onChange,
  idPrefix,
}: {
  fields: string[];
  alreadySet: string[];
  /**
   * Fields the channel works without. Marked in the label, because an unmarked
   * empty password box reads as something you have not found yet — which is how
   * Shopify's `webhookSecret` sent people hunting the Dev Dashboard for a value
   * it does not issue.
   */
  optional?: string[];
  /** Per-field guidance, for the ones where "Stored encrypted" is not the useful thing to say. */
  hints?: Record<string, string>;
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  idPrefix: string;
}) {
  if (fields.length === 0) return null;

  return (
    <div className="schema-form">
      {fields.map((field) => {
        const id = `${idPrefix}-secret-${field}`;
        const isSet = alreadySet.includes(field);
        const isOptional = optional.includes(field);

        return (
          <div key={field} className="schema-field">
            <label htmlFor={id}>
              {humanise(field)}
              {isOptional && <span className="muted"> — optional</span>}
            </label>
            <input
              id={id}
              type="password"
              autoComplete="new-password"
              placeholder={isSet ? '•••••••• (stored — type to replace)' : ''}
              value={value[field] ?? ''}
              onChange={(e) => {
                const next = { ...value };
                // An empty box means "leave it alone", not "clear it".
                if (e.target.value === '') delete next[field];
                else next[field] = e.target.value;
                onChange(next);
              }}
            />
            <p className="field-hint">
              {isSet
                ? 'Stored and encrypted. Leave blank to keep it.'
                : (hints[field] ?? 'Stored encrypted.')}
            </p>
          </div>
        );
      })}
    </div>
  );
}

function humanise(field: string): string {
  return field
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}
