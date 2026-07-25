/**
 * 轻量级 JSON Schema 校验器
 *
 * 为前端工具调用提供 fail-closed 的参数校验，覆盖常见类型、必需字段、枚举、数组/对象结构。
 * 不追求完整 JSON Schema 规范，只实现 LLM tool calling 场景下高频出现的约束。
 */

export interface SchemaValidationError {
  path: string
  message: string
}

export interface SchemaValidationResult {
  valid: boolean
  errors: SchemaValidationError[]
}

interface JsonSchema {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  enum?: unknown[]
  items?: JsonSchema
  additionalProperties?: boolean
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  description?: string
}

export function validateJsonSchema(
  value: unknown,
  schema: unknown,
  path = '$'
): SchemaValidationResult {
  if (!isJsonSchema(schema)) {
    return { valid: true, errors: [] }
  }

  const errors: SchemaValidationError[] = []

  // type 校验
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const matched = types.some((t) => matchesType(value, t))
    if (!matched) {
      errors.push({
        path,
        message: `期望类型为 ${types.join(' / ')}，实际得到 ${describeValueType(value)}`,
      })
      // type 不匹配时，后续属性校验通常无意义
      return { valid: false, errors }
    }
  }

  // enum 校验
  if (schema.enum && Array.isArray(schema.enum)) {
    if (!schema.enum.some((v) => deepEqual(v, value))) {
      errors.push({
        path,
        message: `值必须是以下之一: ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`,
      })
    }
  }

  // 字符串约束
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, message: `字符串长度不能小于 ${schema.minLength}` })
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, message: `字符串长度不能大于 ${schema.maxLength}` })
    }
    if (schema.pattern) {
      try {
        const regex = new RegExp(schema.pattern)
        if (!regex.test(value)) {
          errors.push({ path, message: `字符串不匹配正则: ${schema.pattern}` })
        }
      } catch {
        errors.push({ path, message: `无效的正则表达式: ${schema.pattern}` })
      }
    }
  }

  // 数值约束
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `数值不能小于 ${schema.minimum}` })
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `数值不能大于 ${schema.maximum}` })
    }
  }

  // 对象结构校验
  if (isObject(value) && schema.properties) {
    const required = schema.required || []
    for (const key of required) {
      if (!(key in value) || value[key] === undefined || value[key] === null) {
        errors.push({ path: `${path}.${key}`, message: `缺少必需参数` })
      }
    }

    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in value && value[key] !== undefined) {
        const child = validateJsonSchema(value[key], propSchema, `${path}.${key}`)
        errors.push(...child.errors)
      }
    }

    // additionalProperties
    if (schema.additionalProperties === false) {
      const allowedKeys = new Set(Object.keys(schema.properties))
      for (const key of Object.keys(value)) {
        if (!allowedKeys.has(key)) {
          errors.push({ path: `${path}.${key}`, message: `不允许的额外参数` })
        }
      }
    }
  }

  // 数组元素校验
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      const child = validateJsonSchema(item, schema.items, `${path}[${index}]`)
      errors.push(...child.errors)
    })
  }

  return { valid: errors.length === 0, errors }
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isObject(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return true
  }
}

function describeValueType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  return typeof value
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }

  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const keysA = Object.keys(aObj)
  const keysB = Object.keys(bObj)
  if (keysA.length !== keysB.length) return false
  return keysA.every((k) => keysB.includes(k) && deepEqual(aObj[k], bObj[k]))
}

export function formatSchemaErrors(errors: SchemaValidationError[]): string {
  if (errors.length === 0) return ''
  const lines = errors.map((e) => `${e.path}: ${e.message}`)
  return lines.join('\n')
}
