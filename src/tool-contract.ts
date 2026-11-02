/**
 * Local tool contract. The harness registers plain tool definitions; declaring
 * the shapes here keeps this plugin installable without the harness packages
 * while staying structurally compatible with the host registry.
 * @module dsh-chrome/tool-contract
 */

/** One model-facing parameter. */
export interface ToolParameterSpec {
  /** JSON type of the argument. */
  type: 'string' | 'number' | 'boolean'
  /** Mark the argument required; omitted means optional. */
  required?: true
  /** Model-facing explanation. */
  description?: string
}

/** Model-facing content block returned by the render projection. */
export interface TextContentBlock {
  type: 'text'
  text: string
}

/** Execution identity the host passes to a tool body. */
export interface ToolExec {
  /** Agent on whose behalf the call runs. */
  agent?: { id: string }
  /** Caller-owned cancellation. */
  signal?: AbortSignal
}

/** Canonical output declaration: schema plus model-facing projection. */
export interface ToolOutputSpec {
  /** Raw JSON Schema validated against every successful canonical value. */
  schema: Record<string, unknown>
  /** Pure projection from arguments and value to model content. */
  render(args: unknown, value: unknown): TextContentBlock[]
}

/** A tool registration the host accepts. */
export interface ToolDefinition {
  /** Model-facing tool name. */
  name: string
  /** Model-facing description. */
  description: string
  /** JSON Schema for the arguments. */
  parameters: {
    type: 'object'
    properties: Record<string, ToolParameterSpecShape>
    required?: string[]
  }
  /** Canonical output declaration. */
  output: ToolOutputSpec
  /** Run one accepted call and return its canonical value. */
  execute(args: Record<string, unknown>, exec: ToolExec): Promise<unknown>
}

/** Compiled parameter schema node. */
export interface ToolParameterSpecShape {
  type: 'string' | 'number' | 'boolean'
  description?: string
}

/** Argument types inferred from the declared parameter map. */
export type ToolArgs<P extends Record<string, ToolParameterSpec>> = {
  [K in keyof P as P[K]['required'] extends true ? K : never]:
  P[K]['type'] extends 'string' ? string : P[K]['type'] extends 'number' ? number : boolean
} & {
  [K in keyof P as P[K]['required'] extends true ? never : K]?:
  P[K]['type'] extends 'string' ? string : P[K]['type'] extends 'number' ? number : boolean
}

/** Declarative tool definition accepted by {@link defineTool}. */
export interface DefineToolOptions<P extends Record<string, ToolParameterSpec>> {
  name: string
  description: string
  parameters: P
  output: ToolOutputSpec
  execute(args: ToolArgs<P>, exec: ToolExec): Promise<unknown>
}

/**
 * Compile the parameter map into the JSON Schema the host sends to the model.
 * @param parameters - declared parameters.
 * @returns an object-rooted schema with a `required` list when any parameter demands it.
 */
export function compileParameters(
  parameters: Record<string, ToolParameterSpec>,
): ToolDefinition['parameters'] {
  const properties: Record<string, ToolParameterSpecShape> = {}
  const required: string[] = []
  for (const [name, spec] of Object.entries(parameters)) {
    properties[name] = {
      type: spec.type,
      ...(spec.description === undefined ? {} : { description: spec.description }),
    }
    if (spec.required === true) required.push(name)
  }
  return {
    type: 'object',
    properties,
    ...(required.length === 0 ? {} : { required }),
  }
}

/**
 * Build a tool definition from declarative parts.
 * @param options - name, description, parameters, output, and body.
 * @returns the definition the host registry accepts.
 */
export function defineTool<P extends Record<string, ToolParameterSpec>>(
  options: DefineToolOptions<P>,
): ToolDefinition {
  return {
    name: options.name,
    description: options.description,
    parameters: compileParameters(options.parameters),
    output: options.output,
    async execute(args, exec) {
      return options.execute(args as ToolArgs<P>, exec)
    },
  }
}
