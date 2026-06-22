declare module "json-schema" {
  export type JSONSchema7Definition = JSONSchema7 | boolean;
  export type JSONSchema7TypeName =
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "object"
    | "array"
    | "null";

  export interface JSONSchema7 {
    [key: string]: unknown;
    type?: JSONSchema7TypeName | JSONSchema7TypeName[];
    properties?: Record<string, JSONSchema7Definition>;
    required?: string[];
    additionalProperties?: boolean | JSONSchema7Definition;
    items?: JSONSchema7Definition | JSONSchema7Definition[];
    description?: string;
  }
}
