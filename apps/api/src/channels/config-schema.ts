import type { JsonSchema } from '@hub/connector-sdk';

/**
 * Validate channel config against a connector's declared `configSchema`.
 *
 * Deliberately a focused subset of JSON Schema — object schemas with scalar
 * properties, `required`, `type`, `enum` and `pattern` — matching exactly what
 * the generated settings form can render. Accepting schema keywords the form
 * cannot express would let a connector declare settings no operator could fill
 * in.
 *
 * If connectors ever need richer schemas this should become a real validator
 * (ajv), and the form renderer must grow with it. Until then, hand-rolled keeps
 * the two in step and avoids a dependency whose dialect handling would need
 * pinning.
 */

export interface ConfigIssue {
  field: string;
  message: string;
}

type SchemaProperty = {
  type?: string;
  title?: string;
  enum?: unknown[];
  pattern?: string;
  minimum?: number;
  maximum?: number;
};

export function validateChannelConfig(
  schema: JsonSchema,
  config: Record<string, unknown>,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const properties = (schema.properties ?? {}) as Record<string, SchemaProperty>;
  const required = Array.isArray(schema.required) ? schema.required : [];

  for (const field of required) {
    const value = config[field];
    if (value === undefined || value === null || value === '') {
      issues.push({ field, message: `${label(properties[field], field)} is required.` });
    }
  }

  for (const [field, value] of Object.entries(config)) {
    const property = properties[field];

    // Unknown keys are dropped rather than rejected: a connector upgrade that
    // removes a setting should not lock an operator out of their own channel.
    if (!property || value === undefined || value === null || value === '') continue;

    const name = label(property, field);

    if (property.type === 'string' && typeof value !== 'string') {
      issues.push({ field, message: `${name} must be text.` });
      continue;
    }

    if ((property.type === 'number' || property.type === 'integer') && typeof value !== 'number') {
      issues.push({ field, message: `${name} must be a number.` });
      continue;
    }

    if (property.type === 'integer' && !Number.isInteger(value)) {
      issues.push({ field, message: `${name} must be a whole number.` });
      continue;
    }

    if (property.type === 'boolean' && typeof value !== 'boolean') {
      issues.push({ field, message: `${name} must be true or false.` });
      continue;
    }

    if (property.enum && !property.enum.includes(value)) {
      issues.push({ field, message: `${name} must be one of: ${property.enum.join(', ')}.` });
      continue;
    }

    if (property.pattern && typeof value === 'string') {
      // A connector-supplied pattern is not attacker input, but a malformed one
      // should surface as a clear error rather than a 500.
      try {
        if (!new RegExp(property.pattern).test(value)) {
          issues.push({ field, message: `${name} is not in the expected format.` });
        }
      } catch {
        issues.push({ field, message: `${name} has an invalid validation rule in its connector.` });
      }
    }

    if (typeof value === 'number') {
      if (property.minimum !== undefined && value < property.minimum) {
        issues.push({ field, message: `${name} must be at least ${property.minimum}.` });
      }
      if (property.maximum !== undefined && value > property.maximum) {
        issues.push({ field, message: `${name} must be at most ${property.maximum}.` });
      }
    }
  }

  return issues;
}

/**
 * Keep only properties the schema declares.
 *
 * Channel config is operator-supplied and stored as JSON; without this an
 * arbitrary blob could be written into the column and handed to a connector.
 */
export function pickSchemaFields(
  schema: JsonSchema,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const properties = Object.keys(schema.properties ?? {});
  const out: Record<string, unknown> = {};
  for (const key of properties) {
    if (config[key] !== undefined) out[key] = config[key];
  }
  return out;
}

function label(property: SchemaProperty | undefined, field: string): string {
  return property?.title ?? field;
}
