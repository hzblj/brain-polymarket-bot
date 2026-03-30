import type { z } from 'zod';

/**
 * Converts a Zod schema to a JSON Schema-compatible object.
 * This is a lightweight converter focused on the subset of Zod types
 * used in agent output schemas (objects, strings, numbers, enums, arrays).
 */
export function zodToJsonSchema(schema: z.ZodSchema): Record<string, unknown> {
  return convertZodType(schema._def as z.ZodTypeDef & Record<string, unknown>);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Zod type tree traversal
function convertZodType(def: z.ZodTypeDef & Record<string, unknown>): Record<string, unknown> {
  const typeName = (def as { typeName?: string }).typeName;

  switch (typeName) {
    case 'ZodObject': {
      const shape = (def as { shape: () => Record<string, z.ZodSchema> }).shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!isOptional(value)) {
          required.push(key);
        }
      }

      return {
        type: 'object',
        properties,
        required: required.length > 0 ? required : undefined,
        additionalProperties: false,
      };
    }

    case 'ZodString': {
      const result: Record<string, unknown> = { type: 'string' };
      const checks = (def as { checks?: Array<{ kind: string; value?: unknown }> }).checks ?? [];
      for (const check of checks) {
        if (check.kind === 'min') result.minLength = check.value;
        if (check.kind === 'max') result.maxLength = check.value;
      }
      return result;
    }

    case 'ZodNumber': {
      const result: Record<string, unknown> = { type: 'number' };
      const checks = (def as { checks?: Array<{ kind: string; value?: number }> }).checks ?? [];
      for (const check of checks) {
        if (check.kind === 'min') result.minimum = check.value;
        if (check.kind === 'max') result.maximum = check.value;
        if (check.kind === 'int') result.type = 'integer';
      }
      return result;
    }

    case 'ZodBoolean':
      return { type: 'boolean' };

    case 'ZodEnum': {
      const values = (def as { values: string[] }).values;
      return { type: 'string', enum: values };
    }

    case 'ZodNativeEnum': {
      const values = Object.values((def as { values: Record<string, unknown> }).values);
      return { type: 'string', enum: values };
    }

    case 'ZodArray': {
      const innerType = (def as { type: z.ZodSchema }).type;
      return {
        type: 'array',
        items: zodToJsonSchema(innerType),
      };
    }

    case 'ZodOptional': {
      const innerType = (def as { innerType: z.ZodSchema }).innerType;
      return zodToJsonSchema(innerType);
    }

    case 'ZodNullable': {
      const innerType = (def as { innerType: z.ZodSchema }).innerType;
      const inner = zodToJsonSchema(innerType);
      return { ...inner, nullable: true };
    }

    case 'ZodUnion': {
      const options = (def as { options: z.ZodSchema[] }).options;
      return {
        oneOf: options.map((opt: z.ZodSchema) => zodToJsonSchema(opt)),
      };
    }

    case 'ZodLiteral': {
      const value = (def as { value: unknown }).value;
      return { type: typeof value, const: value };
    }

    case 'ZodRecord': {
      const valueType = (def as { valueType: z.ZodSchema }).valueType;
      return {
        type: 'object',
        additionalProperties: zodToJsonSchema(valueType),
      };
    }

    case 'ZodDefault': {
      const innerType = (def as { innerType: z.ZodSchema }).innerType;
      const inner = zodToJsonSchema(innerType);
      return { ...inner, default: (def as { defaultValue: () => unknown }).defaultValue() };
    }

    case 'ZodEffects': {
      const innerSchema = (def as { schema: z.ZodSchema }).schema;
      return zodToJsonSchema(innerSchema);
    }

    default:
      return {};
  }
}

function isOptional(schema: z.ZodSchema): boolean {
  const typeName = (schema._def as Record<string, unknown>).typeName as string | undefined;
  return typeName === 'ZodOptional' || typeName === 'ZodDefault';
}
