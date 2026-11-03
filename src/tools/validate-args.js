/**
 * Reject a tool call whose arguments do not match the tool's own schema.
 *
 * WHY THIS IS AN ERROR AND NOT A NUDGE
 * ------------------------------------
 * An unknown parameter used to be accepted in silence, and that silence is expensive: the model sends
 * `line_offset` to a tool that takes `start_line`, gets a plausible answer computed from defaults, and has no
 * way to learn that the argument it took trouble to compute was thrown away. The failure then looks like "the
 * tool is broken" rather than "the call was wrong", and the next attempt usually makes the same mistake with
 * a different spelling.
 *
 * So a call carrying a key the schema does not declare is refused before it runs, and the message NAMES the
 * key and lists the ones the tool accepts. `required` properties are checked in the same place: a missing
 * `path` is the same class of mistake and should not reach a tool that will only fail on it later.
 *
 * Deliberately NOT a full JSON-Schema validator. It checks object shape, unknown keys, missing required keys
 * and primitive types, which is what a hand-written tool description needs; a tool that wants to be stricter
 * still validates inside `execute`.
 */

/** The JSON type name for a value, in the vocabulary a schema uses. */
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

/** Whether a value satisfies one schema type name. `number` accepts an integer. */
function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  if (type === 'integer') return actual === 'integer';
  return actual === type;
}

/**
 * Validate arguments against a tool's parameter schema.
 *
 * @param {object|undefined|null} args The parsed arguments.
 * @param {{type?: string, properties?: object, required?: string[]}} [schema] The tool's `parameters`.
 * @returns {string|null} An error message, or null when the call may run.
 */
export function validateToolArgs(args, schema) {
  // A tool with no schema takes anything; there is nothing to be wrong about.
  if (!schema || !schema.properties) return null;
  // A tool whose schema is a free-form object (the shape has no declared properties) also accepts anything.
  const properties = schema.properties || {};
  const declared = Object.keys(properties);
  if (declared.length === 0) return null;

  const isObject = args !== null && typeof args === 'object' && !Array.isArray(args);
  if (!isObject) {
    return `the arguments must be a JSON object with keys: ${declared.join(', ')}`;
  }

  const unknown = Object.keys(args).filter((key) => !(key in properties));
  if (unknown.length > 0) {
    const also = declared.length > 0 ? ` It accepts: ${declared.join(', ')}.` : '';
    return `${unknown.map((k) => `"${k}"`).join(', ')} ${unknown.length === 1 ? 'is not a parameter' : 'are not parameters'}`
      + ` of this tool.${also}`;
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.filter((key) => args[key] === undefined);
  if (missing.length > 0) {
    return `missing required ${missing.length === 1 ? 'parameter' : 'parameters'}: ${missing.join(', ')}`;
  }

  for (const [key, value] of Object.entries(args)) {
    const type = properties[key] && properties[key].type;
    if (type && !matchesType(value, type)) {
      return `"${key}" must be ${type === 'integer' ? 'an' : 'a'} ${type}, got ${typeOf(value)}`;
    }
  }

  return null;
}
