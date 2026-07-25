import type { DagInputSchema, LegacyInputSchemaField } from '@/types/dagWorkflow'
import { normalizeInputSchema } from '@/types/dagWorkflow'

export function generateDummyInputs(
  inputSchema?: DagInputSchema | Record<string, LegacyInputSchemaField> | null
): Record<string, unknown> {
  const schema = normalizeInputSchema(inputSchema)
  const inputs: Record<string, unknown> = {}

  for (const field of schema) {
    if (field.default !== undefined) {
      inputs[field.name] = field.default
      continue
    }

    switch (field.type) {
      case 'string':
        inputs[field.name] = 'dummy'
        break
      case 'number':
        inputs[field.name] = 0
        break
      case 'boolean':
        inputs[field.name] = false
        break
      case 'date':
        inputs[field.name] = new Date().toISOString().slice(0, 10)
        break
      case 'datetime':
        inputs[field.name] = new Date().toISOString()
        break
      case 'select':
        inputs[field.name] = field.options[0]?.value ?? ''
        break
      case 'array':
        inputs[field.name] = []
        break
      case 'object':
        inputs[field.name] = {}
        break
      default:
        inputs[(field as { name: string }).name] = null
        break
    }
  }

  return inputs
}
