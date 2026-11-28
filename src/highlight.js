// Syntax highlighting for the code a session shows: a diff, a Read result, a fenced block.
//
// NO DEPENDENCY, ONE TOKENIZER. A highlighter per language would be fifty parsers to keep correct; what makes a
// listing readable is not its grammar but five things every language has — strings, comments, numbers, keywords
// and calls — and those can be found with one scanner plus a per-language WORD LIST. Where a language has a shape
// the scanner cannot know (a template literal spanning lines, a regex literal) it is handled by a small flag on
// its entry rather than by code of its own.
//
// The colours are the Islands Dark palette, the same source as C's diff colours.
import { C } from './colors.js';

/** Words that read as a keyword, per family. Kept as strings so one set can serve several languages. */
const JS_KEYWORDS = [
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'export', 'extends', 'finally', 'for', 'from', 'function', 'get', 'if', 'import', 'in', 'instanceof',
  'let', 'new', 'of', 'return', 'set', 'static', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var',
  'void', 'while', 'with', 'yield', 'as', 'implements', 'interface', 'type', 'enum', 'declare', 'namespace',
  'readonly', 'private', 'public', 'protected', 'abstract', 'satisfies', 'keyof', 'infer', 'is',
];
const JS_LITERALS = ['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'];

const PY_KEYWORDS = [
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass',
  'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case',
];
const PY_LITERALS = ['True', 'False', 'None', 'NotImplemented', 'Ellipsis'];

const JAVA_LIKE = [
  'abstract', 'assert', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'do', 'else', 'enum',
  'extends', 'final', 'finally', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'interface', 'native',
  'new', 'package', 'private', 'protected', 'public', 'return', 'static', 'strictfp', 'super', 'switch',
  'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'volatile', 'while', 'record', 'sealed',
  'permits', 'var', 'yield',
];
const JAVA_LITERALS = ['true', 'false', 'null'];

const C_LIKE = [
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extern',
  'float', 'for', 'goto', 'if', 'inline', 'int', 'long', 'register', 'restrict', 'return', 'short', 'signed',
  'sizeof', 'static', 'struct', 'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', 'bool',
  'class', 'namespace', 'template', 'typename', 'public', 'private', 'protected', 'virtual', 'override', 'constexpr',
  'using', 'nullptr', 'auto', 'concept', 'requires', 'co_await', 'co_return', 'co_yield',
];
const C_LITERALS = ['true', 'false', 'NULL', 'nullptr'];

const RUST_KEYWORDS = [
  'as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern', 'fn', 'for',
  'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static',
  'struct', 'super', 'trait', 'type', 'unsafe', 'use', 'where', 'while', 'macro_rules',
];
const RUST_LITERALS = ['true', 'false', 'None', 'Some', 'Ok', 'Err'];

const GO_KEYWORDS = [
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go',
  'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type',
  'var',
];
const GO_LITERALS = ['true', 'false', 'nil', 'iota'];

const SHELL_KEYWORDS = [
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'in',
  'return', 'local', 'export', 'readonly', 'declare', 'unset', 'shift', 'source', 'alias', 'command', 'eval',
  'exec', 'exit', 'trap', 'set', 'let',
];

const SQL_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'INSERT', 'INTO', 'VALUES',
  'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'INDEX', 'VIEW', 'ALTER', 'DROP', 'TRUNCATE', 'JOIN', 'INNER',
  'LEFT', 'RIGHT', 'FULL', 'OUTER', 'ON', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'EXISTS', 'BETWEEN',
  'LIKE', 'DISTINCT', 'UNION', 'ALL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'PRIMARY', 'KEY', 'FOREIGN',
  'REFERENCES', 'DEFAULT', 'CASCADE', 'WITH', 'RETURNING',
];
const SQL_LITERALS = ['NULL', 'TRUE', 'FALSE'];

const RUBY_KEYWORDS = [
  'alias', 'begin', 'break', 'case', 'class', 'def', 'defined', 'do', 'else', 'elsif', 'end', 'ensure', 'for',
  'if', 'in', 'module', 'next', 'not', 'or', 'and', 'redo', 'rescue', 'retry', 'return', 'self', 'super', 'then',
  'undef', 'unless', 'until', 'when', 'while', 'yield', 'require', 'include', 'extend', 'attr_accessor',
];
const RUBY_LITERALS = ['true', 'false', 'nil', '__FILE__', '__LINE__'];

const PHP_KEYWORDS = [
  'abstract', 'and', 'array', 'as', 'break', 'case', 'catch', 'class', 'clone', 'const', 'continue', 'declare',
  'default', 'do', 'echo', 'else', 'elseif', 'empty', 'enddeclare', 'endfor', 'endforeach', 'endif', 'endswitch',
  'endwhile', 'extends', 'final', 'finally', 'fn', 'for', 'foreach', 'function', 'global', 'goto', 'if',
  'implements', 'include', 'instanceof', 'insteadof', 'interface', 'isset', 'list', 'match', 'namespace', 'new',
  'or', 'print', 'private', 'protected', 'public', 'require', 'return', 'static', 'switch', 'throw', 'trait',
  'try', 'unset', 'use', 'var', 'while', 'xor', 'yield', 'namespace',
];
const PHP_LITERALS = ['true', 'false', 'null', 'TRUE', 'FALSE', 'NULL'];

const KOTLIN_KEYWORDS = [
  'as', 'break', 'by', 'catch', 'class', 'continue', 'do', 'else', 'false', 'finally', 'for', 'fun', 'if', 'in',
  'interface', 'is', 'null', 'object', 'package', 'return', 'super', 'this', 'throw', 'true', 'try', 'typealias',
  'val', 'var', 'when', 'while', 'suspend', 'data', 'sealed', 'companion', 'inline', 'reified',
];

const CS_KEYWORDS = [
  'abstract', 'as', 'base', 'break', 'case', 'catch', 'checked', 'class', 'const', 'continue', 'default', 'delegate',
  'do', 'else', 'enum', 'event', 'explicit', 'extern', 'finally', 'fixed', 'for', 'foreach', 'goto', 'if',
  'implicit', 'in', 'interface', 'internal', 'is', 'lock', 'namespace', 'new', 'operator', 'out', 'override',
  'params', 'private', 'protected', 'public', 'readonly', 'ref', 'return', 'sealed', 'sizeof', 'stackalloc',
  'static', 'struct', 'switch', 'this', 'throw', 'try', 'typeof', 'unchecked', 'unsafe', 'using', 'virtual',
  'volatile', 'while', 'async', 'await', 'var', 'record', 'init',
];
const CS_LITERALS = ['true', 'false', 'null'];

const SWIFT_KEYWORDS = [
  'associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate', 'func', 'import', 'init', 'inout',
  'internal', 'let', 'open', 'operator', 'private', 'protocol', 'public', 'rethrows', 'static', 'struct',
  'subscript', 'typealias', 'var', 'break', 'case', 'continue', 'default', 'defer', 'do', 'else', 'fallthrough',
  'for', 'guard', 'if', 'in', 'repeat', 'return', 'switch', 'where', 'while', 'as', 'catch', 'is', 'throw',
  'throws', 'try', 'async', 'await', 'some', 'any',
];
const SWIFT_LITERALS = ['true', 'false', 'nil', 'self', 'Self'];

const SCALA_KEYWORDS = [
  'abstract', 'case', 'catch', 'class', 'def', 'do', 'else', 'enum', 'extends', 'final', 'finally', 'for',
  'forSome', 'given', 'if', 'implicit', 'import', 'lazy', 'match', 'new', 'object', 'override', 'package',
  'private', 'protected', 'return', 'sealed', 'super', 'then', 'this', 'throw', 'trait', 'try', 'type', 'val',
  'var', 'while', 'with', 'yield', 'using', 'end',
];
const SCALA_LITERALS = ['true', 'false', 'null', 'None', 'Some'];

const DART_KEYWORDS = [
  'abstract', 'as', 'assert', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'covariant',
  'default', 'deferred', 'do', 'dynamic', 'else', 'enum', 'export', 'extends', 'extension', 'external', 'factory',
  'false', 'final', 'finally', 'for', 'Function', 'get', 'hide', 'if', 'implements', 'import', 'in', 'interface',
  'is', 'late', 'library', 'mixin', 'new', 'null', 'on', 'operator', 'part', 'required', 'rethrow', 'return',
  'sealed', 'set', 'show', 'static', 'super', 'switch', 'sync', 'this', 'throw', 'true', 'try', 'typedef', 'var',
  'void', 'while', 'with', 'yield',
];

const LUA_KEYWORDS = [
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in', 'local', 'nil',
  'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
];

const ELIXIR_KEYWORDS = [
  'def', 'defmodule', 'defp', 'defmacro', 'defstruct', 'do', 'end', 'case', 'cond', 'if', 'unless', 'when', 'fn',
  'with', 'for', 'receive', 'after', 'try', 'catch', 'rescue', 'raise', 'import', 'alias', 'use', 'require',
  'nil', 'true', 'false',
];

const HASKELL_KEYWORDS = [
  'case', 'class', 'data', 'default', 'deriving', 'do', 'else', 'if', 'import', 'in', 'infix', 'instance', 'let',
  'module', 'newtype', 'of', 'then', 'type', 'where', 'qualified', 'as', 'hiding',
];
const HASKELL_LITERALS = ['True', 'False', 'Nothing', 'Just'];

const PERL_KEYWORDS = [
  'my', 'our', 'local', 'sub', 'package', 'use', 'require', 'if', 'elsif', 'else', 'unless', 'while', 'until',
  'for', 'foreach', 'do', 'last', 'next', 'redo', 'return', 'die', 'eval', 'print', 'say', 'chomp', 'split',
  'join', 'push', 'pop', 'shift', 'unshift', 'keys', 'values', 'exists', 'delete', 'defined', 'ref', 'bless',
];

const BATCH_KEYWORDS = [
  'call', 'cd', 'chdir', 'cls', 'copy', 'del', 'dir', 'echo', 'endlocal', 'erase', 'exit', 'for', 'goto', 'if',
  'md', 'mkdir', 'move', 'path', 'pause', 'popd', 'prompt', 'pushd', 'rd', 'ren', 'rename', 'rmdir', 'set',
  'setlocal', 'shift', 'start', 'time', 'title', 'type', 'ver', 'verify', 'vol', 'else', 'exist', 'defined',
  'errorlevel', 'not', 'do', 'in', 'equ', 'neq', 'lss', 'leq', 'gtr', 'geq', 'choice', 'find', 'findstr',
  'sort', 'more', 'xcopy', 'robocopy', 'attrib', 'sc', 'net', 'reg', 'wmic', 'powershell', 'where', 'assoc',
  'ftype', 'mklink', 'taskkill', 'tasklist', 'schtasks', 'certutil', 'icacls', 'takeown', 'runas',
];

const CMD_KEYWORDS = [
  'echo', 'set', 'if', 'goto', 'call', 'for', 'do', 'exit', 'cd', 'chdir', 'md', 'mkdir', 'rd', 'rmdir',
  'del', 'erase', 'copy', 'move', 'ren', 'rename', 'type', 'cls', 'pause', 'start', 'shift', 'setlocal',
  'endlocal', 'defined', 'exist', 'errorlevel', 'not', 'equ', 'neq', 'lss', 'leq', 'gtr', 'geq',
];

const R_KEYWORDS = [
  'if', 'else', 'repeat', 'while', 'function', 'for', 'in', 'next', 'break', 'TRUE', 'FALSE', 'NULL', 'Inf',
  'NaN', 'NA', 'library', 'require',
];

const JULIA_KEYWORDS = [
  'baremodule', 'begin', 'break', 'catch', 'const', 'continue', 'do', 'else', 'elseif', 'end', 'export', 'finally',
  'for', 'function', 'global', 'if', 'import', 'let', 'local', 'macro', 'module', 'quote', 'return', 'struct',
  'try', 'using', 'while', 'mutable', 'abstract', 'primitive', 'where',
];
const JULIA_LITERALS = ['true', 'false', 'nothing', 'missing'];

// ---------------------------------------------------------------------------
// FAMILY KEYWORD SETS
// ---------------------------------------------------------------------------
// A listing is readable because of five things every language has — strings, comments, numbers, keywords, calls.
// Those are what the scanner finds, and what differs between languages is mainly the WORD LIST. Sharing one list
// across a family is what keeps this file a highlighter rather than two hundred parsers.

const LISP_LIKE = ['defun', 'defmacro', 'defvar', 'defparameter', 'lambda', 'let', 'let*', 'if', 'cond', 'when',
  'unless', 'progn', 'setq', 'setf', 'loop', 'do', 'dolist', 'dotimes', 'car', 'cdr', 'cons', 'list', 'quote',
  'function', 'return', 'nil', 't', 'and', 'or', 'not'];

const ML_LIKE = ['let', 'letrec', 'in', 'fun', 'function', 'match', 'with', 'type', 'module', 'struct', 'sig',
  'open', 'include', 'if', 'then', 'else', 'begin', 'end', 'and', 'rec', 'mutable', 'val', 'exception', 'raise',
  'try', 'with', 'as', 'of', 'when', 'new', 'inherit', 'object', 'method', 'class', 'interface', 'namespace'];

const BASIC_LIKE = ['dim', 'as', 'sub', 'end', 'function', 'if', 'then', 'else', 'elseif', 'for', 'to', 'step',
  'next', 'while', 'wend', 'do', 'loop', 'until', 'select', 'case', 'each', 'in', 'exit', 'return', 'call', 'set',
  'let', 'const', 'on', 'error', 'goto', 'print', 'input'];

const PASCAL_LIKE = ['program', 'unit', 'uses', 'interface', 'implementation', 'begin', 'end', 'var', 'const',
  'type', 'procedure', 'function', 'if', 'then', 'else', 'while', 'do', 'for', 'to', 'downto', 'repeat', 'until',
  'case', 'of', 'record', 'class', 'object', 'array', 'string', 'integer', 'boolean', 'real', 'nil', 'with'];

const PROLOG_LIKE = ['is', 'not', 'fail', 'true', 'repeat', 'once', 'assert', 'asserta', 'assertz', 'retract',
  'consult', 'findall', 'bagof', 'setof', 'cut', 'module', 'use_module', 'dynamic', 'discontiguous'];

const HDL_LIKE = ['module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'always', 'initial',
  'begin', 'end', 'if', 'else', 'case', 'endcase', 'for', 'while', 'assign', 'parameter', 'localparam',
  'posedge', 'negedge', 'generate', 'endgenerate', 'function', 'endfunction', 'task', 'endtask'];

const SHADER_LIKE = ['void', 'float', 'int', 'uint', 'bool', 'vec2', 'vec3', 'vec4', 'mat2', 'mat3', 'mat4',
  'sampler2D', 'samplerCube', 'uniform', 'varying', 'attribute', 'in', 'out', 'inout', 'const', 'struct', 'if',
  'else', 'for', 'while', 'do', 'return', 'break', 'continue', 'discard', 'precision', 'highp', 'mediump',
  'lowp', 'layout', 'location', 'main'];

const ASSEMBLY_LIKE = ['mov', 'add', 'sub', 'mul', 'div', 'push', 'pop', 'call', 'ret', 'jmp', 'je', 'jne', 'jz',
  'jnz', 'cmp', 'test', 'lea', 'and', 'or', 'xor', 'not', 'shl', 'shr', 'inc', 'dec', 'nop', 'int', 'syscall',
  'section', 'global', 'extern', 'db', 'dw', 'dd', 'dq'];

const HARDWARE_DESC = ['module', 'input', 'output', 'wire', 'reg', 'always', 'assign', 'case', 'endcase',
  'begin', 'end', 'if', 'else', 'posedge', 'negedge', 'initial', 'parameter'];

const MARKUP_LIKE = ['html', 'head', 'body', 'div', 'span', 'a', 'p', 'ul', 'ol', 'li', 'table', 'tr', 'td',
  'th', 'form', 'input', 'button', 'script', 'style', 'link', 'meta', 'title', 'section', 'header', 'footer'];

const CONFIG_LIKE = ['true', 'false', 'yes', 'no', 'on', 'off', 'null', 'none', 'default'];

const TEMPLATE_LIKE = ['if', 'else', 'elseif', 'endif', 'for', 'endfor', 'foreach', 'endforeach', 'while',
  'endwhile', 'block', 'endblock', 'include', 'extends', 'import', 'from', 'macro', 'endmacro', 'set', 'let',
  'filter', 'endfilter', 'with', 'endwith', 'raw', 'endraw', 'embed', 'endembed', 'use', 'apply'];

const DB_LIKE = ['select', 'from', 'where', 'insert', 'into', 'values', 'update', 'set', 'delete', 'create',
  'table', 'index', 'view', 'drop', 'alter', 'join', 'inner', 'left', 'right', 'outer', 'on', 'as', 'and', 'or',
  'not', 'null', 'is', 'in', 'exists', 'between', 'like', 'distinct', 'union', 'all', 'case', 'when', 'then',
  'else', 'end', 'primary', 'key', 'foreign', 'references', 'default', 'cascade', 'begin', 'commit', 'rollback'];

const STATS_LIKE = ['if', 'else', 'for', 'while', 'repeat', 'function', 'return', 'in', 'next', 'break', 'library',
  'require', 'import', 'true', 'false', 'null'];

const OO_SCRIPT = ['class', 'interface', 'extends', 'implements', 'public', 'private', 'protected', 'static',
  'final', 'abstract', 'new', 'return', 'if', 'else', 'for', 'foreach', 'while', 'do', 'switch', 'case', 'break',
  'continue', 'try', 'catch', 'finally', 'throw', 'throws', 'import', 'package', 'function', 'var', 'let',
  'const', 'this', 'super', 'null', 'true', 'false'];

const SCRIPTING_GENERIC = ['function', 'return', 'if', 'else', 'elseif', 'endif', 'for', 'foreach', 'while',
  'do', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'new', 'class', 'extends',
  'var', 'let', 'const', 'local', 'global', 'in', 'of', 'and', 'or', 'not', 'null', 'true', 'false', 'end'];

const SYSTEMS_GENERIC = ['const', 'var', 'let', 'fn', 'function', 'proc', 'func', 'if', 'else', 'while', 'for',
  'return', 'break', 'continue', 'struct', 'type', 'enum', 'union', 'import', 'use', 'module', 'export', 'public',
  'private', 'static', 'inline', 'extern', 'true', 'false', 'null', 'nil'];

/**
 * Extensions to a language entry.
 *
 *   line     the line-comment marker (`//`, `#`, `--`) or '' for none
 *   block    [open, close] for a block comment, or null
 *   quotes   the string delimiters this language uses
 *   triple   whether `"""` / `'''` open a multi-line string
 *   words    the keyword list
 *   literals the literal list (coloured like values, not like keywords)
 *   raw      a prefix that starts an uninterpreted string (`r"` in Python, `` ` `` in Go)
 *   attr     a line starting with this is a decorator or preprocessor line, coloured as one
 */
const LANGS = {
  javascript: { line: '//', block: ['/*', '*/'], quotes: '\'"`', words: JS_KEYWORDS, literals: JS_LITERALS, regex: true },
  typescript: { line: '//', block: ['/*', '*/'], quotes: '\'"`', words: JS_KEYWORDS, literals: JS_LITERALS, regex: true },
  python: { line: '#', block: null, quotes: '\'"', triple: true, words: PY_KEYWORDS, literals: PY_LITERALS, raw: 'rbfRBF' },
  java: { line: '//', block: ['/*', '*/'], quotes: '"\'', words: JAVA_LIKE, literals: JAVA_LITERALS, attr: '@' },
  kotlin: { line: '//', block: ['/*', '*/'], quotes: '"\'', triple: true, words: KOTLIN_KEYWORDS, literals: [], attr: '@' },
  scala: { line: '//', block: ['/*', '*/'], quotes: '"\'', triple: true, words: SCALA_KEYWORDS, literals: SCALA_LITERALS, attr: '@' },
  csharp: { line: '//', block: ['/*', '*/'], quotes: '"\'', words: CS_KEYWORDS, literals: CS_LITERALS, attr: '#' },
  swift: { line: '//', block: ['/*', '*/'], quotes: '"', triple: true, words: SWIFT_KEYWORDS, literals: SWIFT_LITERALS, attr: '@' },
  c: { line: '//', block: ['/*', '*/'], quotes: '"\'', words: C_LIKE, literals: C_LITERALS, attr: '#' },
  cpp: { line: '//', block: ['/*', '*/'], quotes: '"\'\'', words: C_LIKE, literals: C_LITERALS, attr: '#' },
  rust: { line: '//', block: ['/*', '*/'], quotes: '"', words: RUST_KEYWORDS, literals: RUST_LITERALS, attr: '#' },
  go: { line: '//', block: ['/*', '*/'], quotes: '"`\'', words: GO_KEYWORDS, literals: GO_LITERALS },
  dart: { line: '//', block: ['/*', '*/'], quotes: '"\'\'', words: DART_KEYWORDS, literals: [], attr: '@' },
  zig: { line: '//', block: null, quotes: '"', words: ['const', 'var', 'fn', 'pub', 'return', 'if', 'else', 'while', 'for', 'switch', 'struct', 'enum', 'union', 'error', 'try', 'catch', 'defer', 'comptime', 'inline', 'extern', 'export', 'test', 'orelse', 'unreachable', 'usingnamespace', 'asm', 'break', 'continue'], literals: ['true', 'false', 'null', 'undefined'], attr: '@' },
  ruby: { line: '#', block: null, quotes: '"\'', words: RUBY_KEYWORDS, literals: RUBY_LITERALS, attr: '@' },
  php: { line: '//', block: ['/*', '*/'], quotes: '"\'\'', words: PHP_KEYWORDS, literals: PHP_LITERALS, attr: '#' },
  perl: { line: '#', block: null, quotes: '"\'\'', words: PERL_KEYWORDS, literals: [], raw: 'qr' },
  lua: { line: '--', block: ['--[[', ']]'], quotes: '"\'\'', words: LUA_KEYWORDS, literals: [] },
  elixir: { line: '#', block: null, quotes: '"\'', words: ELIXIR_KEYWORDS, literals: [], attr: '@' },
  haskell: { line: '--', block: ['{-', '-}'], quotes: '"\'', words: HASKELL_KEYWORDS, literals: HASKELL_LITERALS },
  ocaml: { line: '', block: ['(*', '*)'], quotes: '"\'', words: ['let', 'in', 'rec', 'and', 'match', 'with', 'type', 'module', 'open', 'fun', 'function', 'if', 'then', 'else', 'begin', 'end', 'try', 'exception', 'val', 'mutable', 'struct', 'sig', 'include', 'for', 'to', 'downto', 'while', 'do', 'done', 'as', 'when'], literals: ['true', 'false'] },
  fsharp: { line: '//', block: ['(*', '*)'], quotes: '"', words: ['let', 'in', 'rec', 'and', 'match', 'with', 'type', 'module', 'open', 'fun', 'function', 'if', 'then', 'else', 'begin', 'end', 'try', 'exception', 'member', 'interface', 'inherit', 'mutable', 'yield', 'for', 'to', 'downto', 'while', 'do', 'done', 'as', 'when', 'use', 'namespace'], literals: ['true', 'false', 'None', 'Some'] },
  erlang: { line: '%', block: null, quotes: '"\'', words: ['after', 'begin', 'case', 'catch', 'cond', 'end', 'fun', 'if', 'let', 'of', 'query', 'receive', 'try', 'when', 'andalso', 'orelse', 'band', 'bor', 'bnot', 'bsl', 'bsr', 'bxor', 'div', 'rem', 'not', 'and', 'or', 'xor', 'module', 'export', 'import', 'record', 'spec', 'type'], literals: ['true', 'false'] },
  clojure: { line: ';', block: null, quotes: '"', words: ['def', 'defn', 'defmacro', 'let', 'if', 'do', 'fn', 'loop', 'recur', 'when', 'cond', 'case', 'ns', 'require', 'import', 'use', 'and', 'or', 'not', 'nil', 'true', 'false'], literals: [] },
  lisp: { line: ';', block: null, quotes: '"', words: ['defun', 'defvar', 'defmacro', 'let', 'let*', 'if', 'cond', 'progn', 'lambda', 'setq', 'while', 'dolist', 'dotimes', 'car', 'cdr', 'cons', 'list', 'nil', 't'], literals: [] },
  scheme: { line: ';', block: null, quotes: '"', words: ['define', 'lambda', 'let', 'let*', 'letrec', 'if', 'cond', 'else', 'begin', 'set!', 'quote', 'car', 'cdr', 'cons', 'list', 'null?'], literals: ['#t', '#f'] },
  shell: { line: '#', block: null, quotes: '"\'', words: SHELL_KEYWORDS, literals: [] },
  powershell: { line: '#', block: ['<#', '#>'], quotes: '"\'\'', words: ['begin', 'break', 'catch', 'class', 'continue', 'data', 'do', 'dynamicparam', 'else', 'elseif', 'end', 'enum', 'exit', 'filter', 'finally', 'for', 'foreach', 'from', 'function', 'if', 'in', 'param', 'process', 'return', 'switch', 'throw', 'trap', 'try', 'until', 'using', 'var', 'while', 'workflow', 'return', 'function'], literals: ['$true', '$false', '$null'], attr: '[' },
  sql: { line: '--', block: ['/*', '*/'], quotes: '\'"', words: SQL_KEYWORDS, literals: SQL_LITERALS, upper: true },
  json: { line: '', block: null, quotes: '"', words: [], literals: ['true', 'false', 'null'] },
  yaml: { line: '#', block: null, quotes: '\'"', words: [], literals: ['true', 'false', 'null', 'yes', 'no', 'on', 'off'] , keyValue: true },
  toml: { line: '#', block: null, quotes: '\'"', words: [], literals: ['true', 'false'] , keyValue: true },
  ini: { line: ';', block: null, quotes: '\'"', words: [], literals: [] , keyValue: true },
  dockerfile: { line: '#', block: null, quotes: '\'"', words: ['FROM', 'RUN', 'CMD', 'LABEL', 'EXPOSE', 'ENV', 'ADD', 'COPY', 'ENTRYPOINT', 'VOLUME', 'USER', 'WORKDIR', 'ARG', 'ONBUILD', 'STOPSIGNAL', 'HEALTHCHECK', 'SHELL', 'AS'], literals: [] },
  makefile: { line: '#', block: null, quotes: '\'"', words: ['ifeq', 'ifneq', 'ifdef', 'ifndef', 'else', 'endif', 'include', 'define', 'endef', 'export', 'unexport', 'override', 'PHONY'], literals: [] },
  css: { line: '', block: ['/*', '*/'], quotes: '\'"', words: [], literals: [] },
  scss: { line: '//', block: ['/*', '*/'], quotes: '\'"', words: [], literals: [] },
  html: { line: '', block: ['<!--', '-->'], quotes: '\'"', words: [], literals: [] },
  xml: { line: '', block: ['<!--', '-->'], quotes: '\'"', words: [], literals: [] },
  markdown: { line: '', block: ['<!--', '-->'], quotes: '`', words: [], literals: [] },
  r: { line: '#', block: null, quotes: '\'"', words: R_KEYWORDS, literals: [] },
  julia: { line: '#', block: ['#=', '=#'], quotes: '"\'', triple: true, words: JULIA_KEYWORDS, literals: JULIA_LITERALS },
  matlab: { line: '%', block: ['%{', '%}'], quotes: '\'"', words: ['break', 'case', 'catch', 'classdef', 'continue', 'else', 'elseif', 'end', 'for', 'function', 'global', 'if', 'otherwise', 'parfor', 'persistent', 'return', 'spmd', 'switch', 'try', 'while'], literals: ['true', 'false'] },
  verilog: { line: '//', block: ['/*', '*/'], quotes: '"', words: ['module', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'always', 'initial', 'begin', 'end', 'if', 'else', 'case', 'endcase', 'assign', 'parameter', 'localparam', 'posedge', 'negedge', 'function', 'endfunction', 'task', 'endtask', 'for', 'while', 'repeat'], literals: [] },
  vhdl: { line: '--', block: null, quotes: '\'"', words: ['architecture', 'begin', 'entity', 'end', 'is', 'library', 'use', 'port', 'signal', 'process', 'if', 'then', 'else', 'elsif', 'case', 'when', 'component', 'function', 'procedure', 'type', 'constant', 'variable', 'downto', 'to', 'all', 'others'], literals: [] },
  protobuf: { line: '//', block: ['/*', '*/'], quotes: '\'"', words: ['syntax', 'package', 'option', 'import', 'message', 'enum', 'service', 'rpc', 'returns', 'repeated', 'optional', 'required', 'oneof', 'reserved', 'map', 'stream'], literals: ['true', 'false'] },
  graphql: { line: '#', block: null, quotes: '\'"', words: ['query', 'mutation', 'subscription', 'fragment', 'on', 'type', 'input', 'enum', 'interface', 'union', 'schema', 'scalar', 'directive', 'extend', 'implements'], literals: ['true', 'false', 'null'] },
  nginx: { line: '#', block: null, quotes: '\'"', words: ['server', 'location', 'upstream', 'events', 'http', 'listen', 'server_name', 'root', 'index', 'proxy_pass', 'return', 'rewrite', 'if', 'include', 'error_page', 'access_log', 'error_log'], literals: [] },
  terraform: { line: '#', block: ['/*', '*/'], quotes: '"', words: ['resource', 'data', 'variable', 'output', 'module', 'provider', 'locals', 'terraform', 'for_each', 'count', 'depends_on', 'lifecycle', 'dynamic', 'provisioner', 'true', 'false', 'null'], literals: [] },
  diff: { line: '', block: null, quotes: '', words: [], literals: [] },
  /** No highlighting: a language we do not know, or plain prose. */
  // `.bat` / `.cmd`. Comments are `rem` and `::`, and both are LINE comments with no block form. `upper` is not set:
  // cmd.exe is case-insensitive but real scripts are written in lower case, and upper-casing the word list would
  // match only the shouting variants.
  batch: { line: 'rem', lineWord: true, block: null, quotes: '"', words: BATCH_KEYWORDS, literals: ['errorlevel', 'exist'] },
  cmd: { line: 'rem', lineWord: true, block: null, quotes: '"', words: CMD_KEYWORDS, literals: ['errorlevel', 'exist'] },
  racket: { line: '#', block: null, quotes: '"', words: LISP_LIKE, literals: [] },
  'emacs-lisp': { line: ';', block: null, quotes: '"', words: LISP_LIKE, literals: [] },
  commonlisp: { line: ';', block: null, quotes: '"', words: LISP_LIKE, literals: [] },
  fennel: { line: ';', block: null, quotes: '"', words: LISP_LIKE, literals: [] },
  janet: { line: '#', block: null, quotes: '"', words: LISP_LIKE, literals: [] },
  crystal: { line: '#', block: null, quotes: '"', words: RUBY_KEYWORDS, literals: [] },
  nim: { line: '#', block: null, quotes: '"', words: SYSTEMS_GENERIC, literals: [] },
  reasonml: { line: '//', block: ['/*', '*/'], quotes: '"', words: ML_LIKE, literals: [] },
  rescript: { line: '//', block: ['/*', '*/'], quotes: '"', words: ML_LIKE, literals: [] },
  elm: { line: '--', block: ['{-', '-}'], quotes: '"', words: ML_LIKE, literals: [] },
  purescript: { line: '--', block: ['{-', '-}'], quotes: '"', words: HASKELL_KEYWORDS, literals: [] },
  idris: { line: '--', block: ['{-', '-}'], quotes: '"', words: HASKELL_KEYWORDS, literals: [] },
  agda: { line: '--', block: ['{-', '-}'], quotes: '"', words: HASKELL_KEYWORDS, literals: [] },
  lean: { line: '--', block: ['{-', '-}'], quotes: '"', words: HASKELL_KEYWORDS, literals: [] },
  coq: { line: '%', block: null, quotes: '"', words: ML_LIKE, literals: [] },
  isabelle: { line: '%', block: null, quotes: '"', words: ML_LIKE, literals: [] },
  standardml: { line: '%', block: null, quotes: '"', words: ML_LIKE, literals: [] },
  livescript: { line: '#', block: null, quotes: '"', words: SCRIPTING_GENERIC, literals: [] },
  clojurescript: { line: ';', block: null, quotes: '"', words: LISP_LIKE, literals: [] },
  guile: { line: ';', block: null, quotes: '"', words: LISP_LIKE, literals: [] },
  chicken: { line: ';', block: null, quotes: '"', words: LISP_LIKE, literals: [] },
  objectivec: { line: '//', block: ['/*', '*/'], quotes: '"', words: C_LIKE, literals: [] },
  cuda: { line: '//', block: ['/*', '*/'], quotes: '"', words: C_LIKE, literals: [] },
  opencl: { line: '//', block: ['/*', '*/'], quotes: '"', words: C_LIKE, literals: [] },
  metal: { line: '//', block: ['/*', '*/'], quotes: '"', words: C_LIKE, literals: [] },
  hlsl: { line: '//', block: ['/*', '*/'], quotes: '"', words: SHADER_LIKE, literals: [] },
  glsl: { line: '//', block: ['/*', '*/'], quotes: '"', words: SHADER_LIKE, literals: [] },
  wgsl: { line: '//', block: ['/*', '*/'], quotes: '"', words: SHADER_LIKE, literals: [] },
  assembly: { line: ';', block: null, quotes: '"', words: ASSEMBLY_LIKE, literals: [] },
  llvm: { line: ';', block: null, quotes: '"', words: ASSEMBLY_LIKE, literals: [] },
  webassembly: { line: ';', block: null, quotes: '"', words: SYSTEMS_GENERIC, literals: [] },
  ada: { line: '--', block: ['{-', '-}'], quotes: '"', words: PASCAL_LIKE, literals: [] },
  pascal: { line: ';', block: null, quotes: '"', words: PASCAL_LIKE, literals: [] },
  delphi: { line: ';', block: null, quotes: '"', words: PASCAL_LIKE, literals: [] },
  freebasic: { line: ';', block: null, quotes: '"', words: BASIC_LIKE, literals: [] },
  vbnet: { line: ';', block: null, quotes: '"', words: BASIC_LIKE, literals: [] },
  vba: { line: ';', block: null, quotes: '"', words: BASIC_LIKE, literals: [] },
  fortran: { line: '!', block: null, quotes: '"', words: SYSTEMS_GENERIC, literals: [] },
  cobol: { line: ';', block: null, quotes: '"', words: BASIC_LIKE, literals: [] },
  modula2: { line: '%', block: null, quotes: '"', words: PASCAL_LIKE, literals: [] },
  oberon: { line: '%', block: null, quotes: '"', words: PASCAL_LIKE, literals: [] },
  dlang: { line: '//', block: ['/*', '*/'], quotes: '"', words: C_LIKE, literals: [] },
  vala: { line: '//', block: ['/*', '*/'], quotes: '"', words: OO_SCRIPT, literals: [] },
  haxe: { line: '//', block: ['/*', '*/'], quotes: '"', words: OO_SCRIPT, literals: [] },
  pony: { line: '//', block: ['/*', '*/'], quotes: '"', words: SYSTEMS_GENERIC, literals: [] },
  odin: { line: '//', block: ['/*', '*/'], quotes: '"', words: SYSTEMS_GENERIC, literals: [] },
  vlang: { line: '//', block: ['/*', '*/'], quotes: '"', words: SYSTEMS_GENERIC, literals: [] },
  jai: { line: '//', block: ['/*', '*/'], quotes: '"', words: SYSTEMS_GENERIC, literals: [] },
  chapel: { line: '#', block: null, quotes: '"', words: SYSTEMS_GENERIC, literals: [] },
  dafny: { line: '//', block: ['/*', '*/'], quotes: '"', words: ML_LIKE, literals: [] },
  fstar: { line: '//', block: ['/*', '*/'], quotes: '"', words: ML_LIKE, literals: [] },
  koka: { line: '//', block: ['/*', '*/'], quotes: '"', words: ML_LIKE, literals: [] },
  ats: { line: '//', block: ['/*', '*/'], quotes: '"', words: ML_LIKE, literals: [] },
  groovy: { line: '//', block: ['/*', '*/'], quotes: '"', words: OO_SCRIPT, literals: [] },
  gradle: { line: '//', block: ['/*', '*/'], quotes: '"', words: OO_SCRIPT, literals: [] },
  beanshell: { line: '//', block: ['/*', '*/'], quotes: '"', words: OO_SCRIPT, literals: [] },
  ceylon: { line: '//', block: ['/*', '*/'], quotes: '"', words: OO_SCRIPT, literals: [] },
  fantom: { line: '//', block: ['/*', '*/'], quotes: '"', words: OO_SCRIPT, literals: [] },
  xtend: { line: '//', block: ['/*', '*/'], quotes: '"', words: OO_SCRIPT, literals: [] },
  aspectj: { line: '//', block: ['/*', '*/'], quotes: '"', words: JAVA_LIKE, literals: [] },
  processing: { line: '//', block: ['/*', '*/'], quotes: '"', words: JAVA_LIKE, literals: [] },
  arduino: { line: '//', block: ['/*', '*/'], quotes: '"', words: C_LIKE, literals: [] },
  fsharpscript: { line: '//', block: ['/*', '*/'], quotes: '"', words: ML_LIKE, literals: [] },
  csharpscript: { line: '//', block: ['/*', '*/'], quotes: '"', words: CS_KEYWORDS, literals: [] },
  nushell: { line: '#', block: null, quotes: '"', words: SHELL_KEYWORDS, literals: [] },
  elvish: { line: '#', block: null, quotes: '"', words: SHELL_KEYWORDS, literals: [] },
  xonsh: { line: '#', block: null, quotes: '"', words: PY_KEYWORDS, literals: [] },
  oil: { line: '#', block: null, quotes: '"', words: SHELL_KEYWORDS, literals: [] },
  tcl: { line: '#', block: null, quotes: '"', words: SCRIPTING_GENERIC, literals: [] },
  expect: { line: '#', block: null, quotes: '"', words: SCRIPTING_GENERIC, literals: [] },
  awk: { line: '#', block: null, quotes: '"', words: SCRIPTING_GENERIC, literals: [] },
  sed: { line: '#', block: null, quotes: '"', words: SCRIPTING_GENERIC, literals: [] },
  raku: { line: '#', block: null, quotes: '"', words: PERL_KEYWORDS, literals: [] },
  prolog: { line: '%', block: null, quotes: '"', words: PROLOG_LIKE, literals: [] },
  mercury: { line: '%', block: null, quotes: '"', words: PROLOG_LIKE, literals: [] },
  datalog: { line: '%', block: null, quotes: '"', words: PROLOG_LIKE, literals: [] },
  gleam: { line: '//', block: ['/*', '*/'], quotes: '"', words: ML_LIKE, literals: [] },
  moon: { line: '--', block: ['{-', '-}'], quotes: '"', words: LUA_KEYWORDS, literals: [] },
  teal: { line: '--', block: ['{-', '-}'], quotes: '"', words: LUA_KEYWORDS, literals: [] },
  squirrel: { line: '//', block: ['/*', '*/'], quotes: '"', words: SCRIPTING_GENERIC, literals: [] },
  sourcepawn: { line: '//', block: ['/*', '*/'], quotes: '"', words: SCRIPTING_GENERIC, literals: [] },
  papyrus: { line: ';', block: null, quotes: '"', words: SCRIPTING_GENERIC, literals: [] },
  gdscript: { line: '#', block: null, quotes: '"', words: SCRIPTING_GENERIC, literals: [] },
  autohotkey: { line: ';', block: null, quotes: '"', words: BASIC_LIKE, literals: [] },
  autoit: { line: ';', block: null, quotes: '"', words: BASIC_LIKE, literals: [] },
  wren: { line: '//', block: ['/*', '*/'], quotes: '"', words: SCRIPTING_GENERIC, literals: [] },
  rebol: { line: ';', block: null, quotes: '"', words: SCRIPTING_GENERIC, literals: [] },
  ring: { line: ';', block: null, quotes: '"', words: SCRIPTING_GENERIC, literals: [] },
  svelte: { line: '//', block: ['<!--', '-->'], quotes: '"', words: TEMPLATE_LIKE, literals: [] },
  astro: { line: '//', block: ['<!--', '-->'], quotes: '"', words: TEMPLATE_LIKE, literals: [] },
  twig: { line: '//', block: ['{#', '#}'], quotes: '"', words: TEMPLATE_LIKE, literals: [] },
  liquid: { line: '//', block: null, quotes: '"', words: TEMPLATE_LIKE, literals: [] },
  handlebars: { line: '//', block: ['{{!', '}}'], quotes: '"', words: TEMPLATE_LIKE, literals: [] },
  mustache: { line: '//', block: ['{{!', '}}'], quotes: '"', words: TEMPLATE_LIKE, literals: [] },
  ejs: { line: '//', block: ['<%#', '%>'], quotes: '"', words: TEMPLATE_LIKE, literals: [] },
  pug: { line: '//', block: null, quotes: '"', words: TEMPLATE_LIKE, literals: [] },
  haml: { line: '-#', block: null, quotes: '"', words: TEMPLATE_LIKE, literals: [] },
  slim: { line: '/', block: null, quotes: '"', words: TEMPLATE_LIKE, literals: [] },
  jinja: { line: '{#', block: null, quotes: '"', words: TEMPLATE_LIKE, literals: [] },
  erb: { line: '<%#', block: null, quotes: '"', words: TEMPLATE_LIKE, literals: [] },
  razor: { line: '@*', block: ['@*', '*@'], quotes: '"', words: TEMPLATE_LIKE, literals: [] },
  blade: { line: '{{--', block: null, quotes: '"', words: TEMPLATE_LIKE, literals: [] },
  smarty: { line: '{*', block: ['{*', '*}'], quotes: '"', words: TEMPLATE_LIKE, literals: [] },
  velocity: { line: '##', block: ['#*', '*#'], quotes: '"', words: TEMPLATE_LIKE, literals: [] },
  freemarker: { line: '<#--', block: ['<#--', '-->'], quotes: '"', words: TEMPLATE_LIKE, literals: [] },
  xaml: { line: '//', block: ['<!--', '-->'], quotes: '"', words: MARKUP_LIKE, literals: [] },
  xslt: { line: '//', block: ['<!--', '-->'], quotes: '"', words: MARKUP_LIKE, literals: [] },
  htmx: { line: '//', block: ['<!--', '-->'], quotes: '"', words: MARKUP_LIKE, literals: [] },
  coldfusion: { line: '//', block: ['<!---', '--->'], quotes: '"', words: TEMPLATE_LIKE, literals: [] },
  markdownextra: { line: '#', block: null, quotes: '"', words: MARKUP_LIKE, literals: [] },
  asciidoc: { line: '#', block: null, quotes: '"', words: MARKUP_LIKE, literals: [] },
  restructuredtext: { line: '#', block: null, quotes: '"', words: MARKUP_LIKE, literals: [] },
  textile: { line: '#', block: null, quotes: '"', words: MARKUP_LIKE, literals: [] },
  org: { line: '#', block: null, quotes: '"', words: MARKUP_LIKE, literals: [] },
  latex: { line: '%', block: null, quotes: '"', words: MARKUP_LIKE, literals: [] },
  bibtex: { line: '%', block: null, quotes: '"', words: MARKUP_LIKE, literals: [] },
  troff: { line: '%', block: null, quotes: '"', words: MARKUP_LIKE, literals: [] },
  typst: { line: '//', block: ['/*', '*/'], quotes: '"', words: MARKUP_LIKE, literals: [] },
  json5: { line: '//', block: ['/*', '*/'], quotes: '"', words: CONFIG_LIKE, literals: [] },
  jsonl: { line: '//', block: ['/*', '*/'], quotes: '"', words: CONFIG_LIKE, literals: [] },
  hjson: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  properties: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  dotenv: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  gitconfig: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  apacheconf: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  systemdunit: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  kconfig: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  cmake: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  meson: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  ninja: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  bazel: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  starlark: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  gn: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  reg: { line: ';', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  desktopentry: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  plist: { line: '//', block: ['<!--', '-->'], quotes: '"', words: MARKUP_LIKE, literals: [] },
  csv: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  pem: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  logfile: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  psql: { line: '--', block: ['{-', '-}'], quotes: '"', words: DB_LIKE, literals: [] },
  mysql: { line: '#', block: null, quotes: '"', words: DB_LIKE, literals: [] },
  sqlite: { line: '--', block: ['{-', '-}'], quotes: '"', words: DB_LIKE, literals: [] },
  plpgsql: { line: '--', block: ['{-', '-}'], quotes: '"', words: DB_LIKE, literals: [] },
  tsql: { line: '--', block: ['{-', '-}'], quotes: '"', words: DB_LIKE, literals: [] },
  plsql: { line: '--', block: ['{-', '-}'], quotes: '"', words: DB_LIKE, literals: [] },
  hive: { line: '--', block: ['{-', '-}'], quotes: '"', words: DB_LIKE, literals: [] },
  bigquery: { line: '#', block: null, quotes: '"', words: DB_LIKE, literals: [] },
  cypher: { line: '//', block: ['/*', '*/'], quotes: '"', words: DB_LIKE, literals: [] },
  prisma: { line: '//', block: ['/*', '*/'], quotes: '"', words: DB_LIKE, literals: [] },
  cassandra: { line: '--', block: ['{-', '-}'], quotes: '"', words: DB_LIKE, literals: [] },
  dockercompose: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  helm: { line: '#', block: null, quotes: '"', words: TEMPLATE_LIKE, literals: [] },
  kustomize: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  ansible: { line: '#', block: null, quotes: '"', words: TEMPLATE_LIKE, literals: [] },
  terragrunt: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  packer: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  pulumi: { line: '//', block: ['/*', '*/'], quotes: '"', words: OO_SCRIPT, literals: [] },
  nix: { line: '#', block: null, quotes: '"', words: ML_LIKE, literals: [] },
  guix: { line: ';', block: null, quotes: '"', words: LISP_LIKE, literals: [] },
  bicep: { line: '//', block: ['/*', '*/'], quotes: '"', words: CONFIG_LIKE, literals: [] },
  puppet: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  salt: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  prometheus: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  openapi: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  postman: { line: '//', block: ['/*', '*/'], quotes: '"', words: CONFIG_LIKE, literals: [] },
  insomnia: { line: '//', block: ['/*', '*/'], quotes: '"', words: CONFIG_LIKE, literals: [] },
  har: { line: '//', block: ['/*', '*/'], quotes: '"', words: CONFIG_LIKE, literals: [] },
  iptables: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  nftables: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  crontab: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  fstab: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  hosts: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  sshconfig: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  protobuftext: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  flatbuffers: { line: '//', block: ['/*', '*/'], quotes: '"', words: CONFIG_LIKE, literals: [] },
  capnp: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  thrift: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  avro: { line: '//', block: ['/*', '*/'], quotes: '"', words: CONFIG_LIKE, literals: [] },
  asn1: { line: '--', block: ['{-', '-}'], quotes: '"', words: CONFIG_LIKE, literals: [] },
  wsdl: { line: '//', block: ['<!--', '-->'], quotes: '"', words: MARKUP_LIKE, literals: [] },
  idl: { line: '//', block: ['/*', '*/'], quotes: '"', words: C_LIKE, literals: [] },
  smithy: { line: '//', block: ['/*', '*/'], quotes: '"', words: CONFIG_LIKE, literals: [] },
  jsonnet: { line: '//', block: ['/*', '*/'], quotes: '"', words: CONFIG_LIKE, literals: [] },
  cue: { line: '//', block: ['/*', '*/'], quotes: '"', words: CONFIG_LIKE, literals: [] },
  dhall: { line: '--', block: ['{-', '-}'], quotes: '"', words: CONFIG_LIKE, literals: [] },
  nickel: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  ron: { line: '//', block: ['/*', '*/'], quotes: '"', words: CONFIG_LIKE, literals: [] },
  kdl: { line: '//', block: ['/*', '*/'], quotes: '"', words: CONFIG_LIKE, literals: [] },
  algol: { line: ';', block: null, quotes: '"', words: PASCAL_LIKE, literals: [] },
  simula: { line: '!', block: null, quotes: '"', words: PASCAL_LIKE, literals: [] },
  smalltalk: { line: '#', block: null, quotes: '"', words: OO_SCRIPT, literals: [] },
  squeak: { line: '#', block: null, quotes: '"', words: OO_SCRIPT, literals: [] },
  self: { line: '//', block: ['/*', '*/'], quotes: '"', words: OO_SCRIPT, literals: [] },
  logo: { line: ';', block: null, quotes: '"', words: BASIC_LIKE, literals: [] },
  scratch: { line: '//', block: ['/*', '*/'], quotes: '"', words: BASIC_LIKE, literals: [] },
  snap: { line: '//', block: ['/*', '*/'], quotes: '"', words: BASIC_LIKE, literals: [] },
  applescript: { line: '--', block: null, quotes: '"', words: SCRIPTING_GENERIC, literals: [] },
  actionscript: { line: '//', block: ['/*', '*/'], quotes: '"', words: OO_SCRIPT, literals: [] },
  lingo: { line: '--', block: null, quotes: '"', words: SCRIPTING_GENERIC, literals: [] },
  lasso: { line: '#', block: null, quotes: '"', words: SCRIPTING_GENERIC, literals: [] },
  amped: { line: ';', block: null, quotes: '"', words: SCRIPTING_GENERIC, literals: [] },
  raptor: { line: ';', block: null, quotes: '"', words: SCRIPTING_GENERIC, literals: [] },
  harbour: { line: '//', block: ['/*', '*/'], quotes: '"', words: BASIC_LIKE, literals: [] },
  xbase: { line: '//', block: ['/*', '*/'], quotes: '"', words: BASIC_LIKE, literals: [] },
  clipper: { line: '//', block: ['/*', '*/'], quotes: '"', words: BASIC_LIKE, literals: [] },
  foxpro: { line: '//', block: ['/*', '*/'], quotes: '"', words: BASIC_LIKE, literals: [] },
  luaplus: { line: '--', block: null, quotes: '"', words: LUA_KEYWORDS, literals: [] },
  terra: { line: '//', block: ['/*', '*/'], quotes: '"', words: LUA_KEYWORDS, literals: [] },
  nelua: { line: '#', block: null, quotes: '"', words: LUA_KEYWORDS, literals: [] },
  moonscript: { line: '--', block: null, quotes: '"', words: LUA_KEYWORDS, literals: [] },
  carp: { line: ';', block: null, quotes: '"', words: LISP_LIKE, literals: [] },
  shen: { line: ';', block: null, quotes: '"', words: LISP_LIKE, literals: [] },
  'pico-lisp': { line: ';', block: null, quotes: '"', words: LISP_LIKE, literals: [] },
  newlisp: { line: ';', block: null, quotes: '"', words: LISP_LIKE, literals: [] },
  picolisp: { line: ';', block: null, quotes: '"', words: LISP_LIKE, literals: [] },
  txl: { line: '%', block: null, quotes: '"', words: ML_LIKE, literals: [] },
  ' curry': { line: '//', block: ['/*', '*/'], quotes: '"', words: HASKELL_KEYWORDS, literals: [] },
  unison: { line: '//', block: ['/*', '*/'], quotes: '"', words: ML_LIKE, literals: [] },
  ballerina: { line: '//', block: ['/*', '*/'], quotes: '"', words: OO_SCRIPT, literals: [] },
  grain: { line: '//', block: ['/*', '*/'], quotes: '"', words: ML_LIKE, literals: [] },
  flix: { line: '//', block: ['/*', '*/'], quotes: '"', words: ML_LIKE, literals: [] },
  roc: { line: '#', block: null, quotes: '"', words: ML_LIKE, literals: [] },
  'unison-lang': { line: '//', block: ['/*', '*/'], quotes: '"', words: ML_LIKE, literals: [] },
  sway: { line: '//', block: ['/*', '*/'], quotes: '"', words: SYSTEMS_GENERIC, literals: [] },
  carbon: { line: '//', block: ['/*', '*/'], quotes: '"', words: C_LIKE, literals: [] },
  vale: { line: '//', block: ['/*', '*/'], quotes: '"', words: SYSTEMS_GENERIC, literals: [] },
  mojo: { line: '#', block: null, quotes: '"', words: PY_KEYWORDS, literals: [] },
  mint: { line: '//', block: ['/*', '*/'], quotes: '"', words: OO_SCRIPT, literals: [] },
  krystal: { line: '#', block: null, quotes: '"', words: RUBY_KEYWORDS, literals: [] },
  myst: { line: '//', block: ['/*', '*/'], quotes: '"', words: SCRIPTING_GENERIC, literals: [] },
  bosque: { line: '//', block: ['/*', '*/'], quotes: '"', words: SYSTEMS_GENERIC, literals: [] },
  bex: { line: '//', block: ['/*', '*/'], quotes: '"', words: SYSTEMS_GENERIC, literals: [] },
  lean4: { line: '--', block: null, quotes: '"', words: HASKELL_KEYWORDS, literals: [] },
  redscript: { line: ';', block: null, quotes: '"', words: SCRIPTING_GENERIC, literals: [] },
  angelscript: { line: '//', block: ['/*', '*/'], quotes: '"', words: SCRIPTING_GENERIC, literals: [] },
  unrealscript: { line: '//', block: ['/*', '*/'], quotes: '"', words: OO_SCRIPT, literals: [] },
  'hlsl-fx': { line: '//', block: ['/*', '*/'], quotes: '"', words: SHADER_LIKE, literals: [] },
  'pixel-bender': { line: '//', block: ['/*', '*/'], quotes: '"', words: SHADER_LIKE, literals: [] },
  'cuda-hip': { line: '//', block: ['/*', '*/'], quotes: '"', words: C_LIKE, literals: [] },
  sycl: { line: '//', block: ['/*', '*/'], quotes: '"', words: C_LIKE, literals: [] },
  ispc: { line: '//', block: ['/*', '*/'], quotes: '"', words: C_LIKE, literals: [] },
  halide: { line: '//', block: ['/*', '*/'], quotes: '"', words: C_LIKE, literals: [] },
  slang: { line: '//', block: ['/*', '*/'], quotes: '"', words: SHADER_LIKE, literals: [] },
  naga: { line: '//', block: ['/*', '*/'], quotes: '"', words: SHADER_LIKE, literals: [] },
  jsonata: { line: '//', block: ['/*', '*/'], quotes: '"', words: CONFIG_LIKE, literals: [] },
  jq: { line: '#', block: null, quotes: '"', words: CONFIG_LIKE, literals: [] },
  xpath: { line: '//', block: ['/*', '*/'], quotes: '"', words: CONFIG_LIKE, literals: [] },
  xsd: { line: '//', block: ['<!--', '-->'], quotes: '"', words: MARKUP_LIKE, literals: [] },
  dtd: { line: '//', block: ['<!--', '-->'], quotes: '"', words: MARKUP_LIKE, literals: [] },
  sdl: { line: '//', block: ['/*', '*/'], quotes: '"', words: CONFIG_LIKE, literals: [] },
  plantuml: { line: '//', block: null, quotes: '"', words: MARKUP_LIKE, literals: [] },
  mermaid: { line: '%%', block: null, quotes: '"', words: MARKUP_LIKE, literals: [] },
  graphviz: { line: '//', block: null, quotes: '"', words: MARKUP_LIKE, literals: [] },
  dbml: { line: '//', block: null, quotes: '"', words: DB_LIKE, literals: [] },
  text: { line: '', block: null, quotes: '', words: [], literals: [] },
};

/** Extension to language. Unknown extensions fall back to `text`, which renders unchanged. */
const BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', pyw: 'python', pyi: 'python',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', sc: 'scala',
  cs: 'csharp', fs: 'fsharp', swift: 'swift',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  rs: 'rust', go: 'go', dart: 'dart', zig: 'zig',
  rb: 'ruby', rake: 'ruby', gemspec: 'ruby', php: 'php', pl: 'perl', pm: 'perl', lua: 'lua',
  ex: 'elixir', exs: 'elixir', erl: 'erlang', hrl: 'erlang',
  hs: 'haskell', lhs: 'haskell', ml: 'ocaml', mli: 'ocaml', clj: 'clojure', cljs: 'clojure',
  el: 'lisp', lisp: 'lisp', scm: 'scheme', ss: 'scheme',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  bat: 'batch', cmd: 'batch', btm: 'batch',
  sql: 'sql', json: 'json', jsonc: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini', conf: 'nginx',
  css: 'css', scss: 'scss', sass: 'scss', less: 'scss',
  html: 'html', htm: 'html', xml: 'xml', svg: 'xml', vue: 'html',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  r: 'r', jl: 'julia', m: 'matlab',
  v: 'verilog', sv: 'verilog', vhd: 'vhdl', vhdl: 'vhdl',
  proto: 'protobuf', graphql: 'graphql', gql: 'graphql', tf: 'terraform',
  rkt: 'racket',
  el: 'emacs-lisp',
  lsp: 'commonlisp',
  fnl: 'fennel',
  janet: 'janet',
  cr: 'crystal',
  nim: 'nim',
  nims: 'nim',
  re: 'reasonml',
  rei: 'reasonml',
  res: 'rescript',
  resi: 'rescript',
  elm: 'elm',
  purs: 'purescript',
  idr: 'idris',
  agda: 'agda',
  lean: 'lean',
  v: 'coq',
  thy: 'isabelle',
  sml: 'standardml',
  ls: 'livescript',
  cljc: 'clojurescript',
  scm4: 'guile',
  scm5: 'chicken',
  mm: 'objectivec',
  cu: 'cuda',
  cuh: 'cuda',
  cl: 'opencl',
  metal: 'metal',
  hlsl: 'hlsl',
  glsl: 'glsl',
  vert: 'glsl',
  frag: 'glsl',
  geom: 'glsl',
  tesc: 'glsl',
  tese: 'glsl',
  wgsl: 'wgsl',
  asm: 'assembly',
  nasm: 'assembly',
  ll: 'llvm',
  wat: 'webassembly',
  wast: 'webassembly',
  adb: 'ada',
  ads: 'ada',
  pas: 'pascal',
  pp: 'pascal',
  dpr: 'delphi',
  bas: 'freebasic',
  bi: 'freebasic',
  vb: 'vbnet',
  vba: 'vba',
  f90: 'fortran',
  f95: 'fortran',
  f03: 'fortran',
  f08: 'fortran',
  cob: 'cobol',
  cbl: 'cobol',
  mod: 'modula2',
  ob2: 'oberon',
  di: 'dlang',
  vala: 'vala',
  hx: 'haxe',
  pony: 'pony',
  odin: 'odin',
  v2: 'vlang',
  vv: 'vlang',
  jai: 'jai',
  chpl: 'chapel',
  dfy: 'dafny',
  fst: 'fstar',
  kk: 'koka',
  dats: 'ats',
  groovy: 'groovy',
  gvy: 'groovy',
  gradle: 'gradle',
  bsh: 'beanshell',
  ceylon: 'ceylon',
  fan: 'fantom',
  xtend: 'xtend',
  aj: 'aspectj',
  pde: 'processing',
  ino: 'arduino',
  fsx: 'fsharpscript',
  csx: 'csharpscript',
  nu: 'nushell',
  elv: 'elvish',
  xsh: 'xonsh',
  osh: 'oil',
  tcl: 'tcl',
  tk: 'tcl',
  exp: 'expect',
  awk: 'awk',
  sed: 'sed',
  raku: 'raku',
  p6: 'raku',
  pm6: 'raku',
  pro: 'prolog',
  prolog: 'prolog',
  m2: 'mercury',
  dl: 'datalog',
  gleam: 'gleam',
  moon: 'moon',
  tl: 'teal',
  nut: 'squirrel',
  sp: 'sourcepawn',
  psc: 'papyrus',
  gd: 'gdscript',
  ahk: 'autohotkey',
  au3: 'autoit',
  wren: 'wren',
  reb: 'rebol',
  ring: 'ring',
  svelte: 'svelte',
  astro: 'astro',
  twig: 'twig',
  liquid: 'liquid',
  hbs: 'handlebars',
  handlebars: 'handlebars',
  mustache: 'mustache',
  ejs: 'ejs',
  pug: 'pug',
  jade: 'pug',
  haml: 'haml',
  slim: 'slim',
  jinja: 'jinja',
  jinja2: 'jinja',
  j2: 'jinja',
  erb: 'erb',
  cshtml: 'razor',
  razor: 'razor',
  blade: 'blade',
  tpl: 'smarty',
  vm: 'velocity',
  ftl: 'freemarker',
  xaml: 'xaml',
  xsl: 'xslt',
  xslt: 'xslt',
  htmx: 'htmx',
  cfm: 'coldfusion',
  cfc: 'coldfusion',
  mkd: 'markdownextra',
  mdown: 'markdownextra',
  adoc: 'asciidoc',
  asciidoc: 'asciidoc',
  rst: 'restructuredtext',
  textile: 'textile',
  org: 'org',
  tex: 'latex',
  sty: 'latex',
  cls: 'latex',
  bib: 'bibtex',
  roff: 'troff',
  troff: 'troff',
  typ: 'typst',
  json5: 'json5',
  jsonl: 'jsonl',
  ndjson: 'jsonl',
  hjson: 'hjson',
  properties: 'properties',
  env: 'dotenv',
  gitconfig: 'gitconfig',
  htaccess: 'apacheconf',
  service: 'systemdunit',
  socket: 'systemdunit',
  timer: 'systemdunit',
  kconfig: 'kconfig',
  cmake: 'cmake',
  meson: 'meson',
  ninja: 'ninja',
  bzl: 'bazel',
  bazel: 'bazel',
  star: 'starlark',
  gni: 'gn',
  reg: 'reg',
  desktop: 'desktopentry',
  plist: 'plist',
  csv: 'csv',
  tsv: 'csv',
  pem: 'pem',
  crt: 'pem',
  cer: 'pem',
  log: 'logfile',
  psql: 'psql',
  mysql: 'mysql',
  sqlite: 'sqlite',
  plpgsql: 'plpgsql',
  pgsql: 'plpgsql',
  tsql: 'tsql',
  mssql: 'tsql',
  plsql: 'plsql',
  pks: 'plsql',
  pkb: 'plsql',
  hql: 'hive',
  bq: 'bigquery',
  cql: 'cypher',
  cypher: 'cypher',
  prisma: 'prisma',
  cassandra: 'cassandra',
  compose: 'dockercompose',
  helm: 'helm',
  kustomization: 'kustomize',
  ansible: 'ansible',
  hcl: 'terragrunt',
  pkr: 'packer',
  pulumi: 'pulumi',
  nix: 'nix',
  guix: 'guix',
  bicep: 'bicep',
  pp2: 'puppet',
  sls: 'salt',
  prom: 'prometheus',
  openapi: 'openapi',
  postman: 'postman',
  insomnia: 'insomnia',
  har: 'har',
  iptables: 'iptables',
  nft: 'nftables',
  cron: 'crontab',
  crontab: 'crontab',
  fstab: 'fstab',
  hosts: 'hosts',
  sshconfig: 'sshconfig',
  pbtxt: 'protobuftext',
  textproto: 'protobuftext',
  fbs: 'flatbuffers',
  capnp: 'capnp',
  thrift: 'thrift',
  avsc: 'avro',
  asn: 'asn1',
  asn1: 'asn1',
  wsdl: 'wsdl',
  idl: 'idl',
  smithy: 'smithy',
  jsonnet: 'jsonnet',
  libsonnet: 'jsonnet',
  cue: 'cue',
  dhall: 'dhall',
  ncl: 'nickel',
  ron: 'ron',
  kdl: 'kdl',
  alg: 'algol',
  sim: 'simula',
  st: 'smalltalk',
  sq: 'squeak',
  self: 'self',
  logo: 'logo',
  sb3: 'scratch',
  snap: 'snap',
  applescript: 'applescript',
  as: 'actionscript',
  lingo: 'lingo',
  lasso: 'lasso',
  amped: 'amped',
  raptor: 'raptor',
  prg: 'harbour',
  dbf: 'xbase',
  ntx: 'clipper',
  fxp: 'foxpro',
  lua5: 'luaplus',
  t2: 'terra',
  nelua: 'nelua',
  moon2: 'moonscript',
  carp: 'carp',
  shen: 'shen',
  plisp: 'pico-lisp',
  nl: 'newlisp',
  picolisp: 'picolisp',
  txl: 'txl',
  curry: ' curry',
  u: 'unison',
  bal: 'ballerina',
  gr: 'grain',
  flix: 'flix',
  roc: 'roc',
  uu: 'unison-lang',
  sw: 'sway',
  carbon: 'carbon',
  vale: 'vale',
  mojo: 'mojo',
  mint: 'mint',
  krystal: 'krystal',
  myst: 'myst',
  bsq: 'bosque',
  bex: 'bex',
  lean4: 'lean4',
  reds2: 'redscript',
  asc: 'angelscript',
  uc: 'unrealscript',
  fx: 'hlsl-fx',
  pixelbender: 'pixel-bender',
  hip: 'cuda-hip',
  sycl: 'sycl',
  ispc: 'ispc',
  halide: 'halide',
  slang: 'slang',
  naga: 'naga',
  jsonata: 'jsonata',
  jq: 'jq',
  xpath: 'xpath',
  xsd: 'xsd',
  dtd: 'dtd',
  sdl: 'sdl',
  puml: 'plantuml',
  plantuml: 'plantuml',
  mmd: 'mermaid',
  mermaid: 'mermaid',
  dot: 'graphviz',
  gv: 'graphviz',
  dbml: 'dbml',
  diff: 'diff', patch: 'diff',
};

/** The language for a path, by extension, then by a few well-known bare names. */
export function langForPath(p) {
  const base = String(p == null ? '' : p).split(/[\\/]/).pop().toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return LANGS.dockerfile;
  if (base === 'makefile' || base === 'gnumakefile') return LANGS.makefile;
  if (base === 'vite.config' || base === 'package.json') return LANGS.json;
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  return LANGS[BY_EXT[ext]] || LANGS.text;
}

/**
 * Token kind -> colour, resolved on EVERY call rather than captured once.
 *
 * `C` is a live object that `setTheme` rewrites in place. Reading `C.cyan` at module load froze the colour of the
 * theme that happened to be active when the file was first imported, so `/theme` changed every other colour on
 * screen and left code tinted like the old one.
 *
 * Every value must be a key `C` actually EXPORTS. `C.blue` did not exist — the theme tables carry a `blue` entry
 * but `C` never surfaces it — so `func` was `undefined` and every call to a function, and every YAML key, silently
 * rendered uncoloured.
 */
function colorFor(kind) {
  switch (kind) {
    case 'keyword': return C.cyan;
    // NUMBERS ARE NOT LITERALS, and they are not comments either.
    //
    // This used to return `C.heading`, the same colour `literal` gets — so `42` and `true` were one family when one is
    // a value you scan for and the other is a word. Worse, on the dark theme `heading` (200,210,220) sits within about
    // 30 of `comment` (184,189,191) in every channel, so a number read as dim as a comment.
    //
    // Orange is already the theme's "attention without alarm" accent, and it is far enough from cyan, green and the
    // comment grey to be picked out at a glance.
    case 'number': return C.orange;
    case 'literal': return C.heading;
    case 'string': return C.diffAddFg;
    // COMMENTS ARE DERIVED FROM THE FOREGROUND, not from the theme's grey.
    //
    // `C.gray` is tuned to sit quiet against the PAGE background, and in several themes it lands almost exactly on the
    // diff wash — dracula and tokyo came out at a brightness difference of 3 to 5, which is invisible. A comment is the
    // one token that has to stay readable ON the wash, so it comes from `C.comment`: quiet, but always far enough from
    // whatever is behind it.
    case 'comment': return C.comment;
    // A FUNCTION NAME IS NOT A KEYWORD.
    //
    // Both were `C.cyan`, which made `function` and the name after it one undifferentiated run: the reader could not
    // tell the syntax from the thing being called, and a call site (`foo(x)`) read as if `foo` were built in.
    // `C.spring` is the palette's second cool accent — same family as the keyword colour, so the line still reads as
    // code, and far enough from it to separate the two roles.
    case 'func': return C.spring;
    case 'attr': return C.orange;
    default: return '';
  }
}

/**
 * Colour one line of source.
 *
 * A LINE AT A TIME, deliberately: the caller renders rows and tracks its own wrapping, and a tokenizer that
 * needed to see the whole file could not run on a diff (which is two fragments of a file, not a file).
 *
 * A multi-line string or block comment is not tracked across calls — the row would need state threaded through
 * every renderer. In practice a diff's rows are short and the mismatch shows as one line of a block comment drawn
 * as ordinary text, which is a small price for a highlighter that cannot get out of step.
 *
 * Returns the text with ANSI codes inserted. Unknown languages return it unchanged.
 */
export function highlightLine(text, lang, inComment = false) {
  const L = lang && typeof lang === 'object' ? lang : null;
  if (!L || !L.words || !L.words.length && !L.quotes) return { text: String(text), inComment: false };
  const src = String(text);
  // AN EMPTY ROW KEEPS THE STATE: the line is blank, not the comment. Resetting here made the row after a
  // blank line inside `/* ... */` read as ordinary code, and its `const` came out as a keyword.
  if (!src) return { text: src, inComment };

  const words = new Set(L.words || []);
  const literals = new Set(L.literals || []);
  const quotes = L.quotes || '';
  const upper = !!L.upper;

  let out = '';
  let i = 0;
  const paint = (s, kind) => {
    const c = colorFor(kind);
    return c ? c + s + C.reset : s;
  };

  // A `key:` at the start of a line is the one structure YAML, TOML tables and INI share, and it is what a reader
  // navigates by. Those languages have no keywords to match on, so the shape is matched instead.
  if (L.keyValue) {
    const m = /^(\s*)([A-Za-z_][\w.-]*)(\s*:)/.exec(src);
    if (m) {
      const tail = src.slice(m[0].length);
      const rest = tail ? highlightLine(tail, { ...L, keyValue: false }) : { text: '', inComment: false };
      return { text: m[1] + paint(m[2], 'func') + m[3] + rest.text, inComment: rest.inComment };
    }
  }


  // A line that is a preprocessor directive or a decorator is coloured whole — its own grammar is not worth
  // parsing and the visual cue is the point.
  if (L.attr && src.trimStart().startsWith(L.attr)) {
    const lead = src.slice(0, src.length - src.trimStart().length);
    return { text: lead + paint(src.trimStart(), 'attr'), inComment: false };
  }

  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);

    // Block comment opener.
    if (L.block && rest.startsWith(L.block[0])) {
      const end = src.indexOf(L.block[1], i + L.block[0].length);
      const stop = end < 0 ? src.length : end + L.block[1].length;
      out += paint(src.slice(i, stop), 'comment');
      // THE ROW ENDED INSIDE THE COMMENT when there is no closing marker on it. The caller passes this back in
      // for the next row, which is what keeps a multi-line comment grey all the way down.
      if (end < 0) return { text: out, inComment: true };
      i = stop;
      continue;
    }
    // Line comment.
    // THE ROW BEGINS INSIDE A BLOCK COMMENT. Everything up to the closing marker is comment, and the rest of
    // the row is ordinary code again.
    if (inComment && L.block) {
      const closeAt = src.indexOf(L.block[1]);
      if (closeAt < 0) return { text: paint(src, 'comment'), inComment: true };
      out += paint(src.slice(0, closeAt + L.block[1].length), 'comment');
      i = closeAt + L.block[1].length;
      inComment = false;
    }
    // A LINE COMMENT IS A MARKER, EXCEPT WHEN THE LANGUAGE SAYS IT IS A WORD.
    //
    // `#` and `//` are punctuation and cannot appear in an identifier, so `startsWith` is exact. Batch's comment is
    // the WORD `rem`, and a prefix test made `remember` a comment to the end of the line. `lineWord: true` requires
    // the marker to end where the identifier does.
    if (L.line) {
      const isWord = L.lineWord
        ? rest.startsWith(L.line) && !/[\w-]/.test(src[i + L.line.length] || '')
        : rest.startsWith(L.line);
      if (isWord && (!L.lineWord || i === 0 || !/[\w-]/.test(src[i - 1]))) {
        out += paint(src.slice(i), 'comment');
        break;
      }
    }

    // String. A raw prefix (`r"` in Python, `` ` `` in Go) is handled by treating the prefix as part of the quote
    // run — the whole literal is one colour either way.
    if (quotes.includes(ch)) {
      const triple = L.triple && rest.startsWith(ch + ch + ch);
      const delim = triple ? ch + ch + ch : ch;
      let j = i + delim.length;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (!triple && src[j] === ch && !(L.raw && ch === '"' && /\\$/.test(''))) { j++; break; }
        if (triple && src.startsWith(delim, j)) { j += delim.length; break; }
        j++;
      }
      out += paint(src.slice(i, Math.min(j, src.length)), 'string');
      i = Math.min(j, src.length);
      continue;
    }

    // Number: digits, a decimal part, an exponent, and a trailing unit letter (`10px`, `1e5`, `0x1f`).
    if (/[0-9]/.test(ch) && !/[A-Za-z_$]/.test(src[i - 1] || '')) {
      const m = /^(?:0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?)(?:[a-zA-Z]{1,4}\b)?/.exec(rest);
      if (m) { out += paint(m[0], 'number'); i += m[0].length; continue; }
    }

    // Identifier or keyword.
    if (/[A-Za-z_$@]/.test(ch)) {
      const m = /^[A-Za-z_$@][A-Za-z0-9_$]*/.exec(rest);
      const word = m[0];
      const key = upper ? word.toUpperCase() : word;
      // A name followed directly by `(` is a call, which reads as a function even when the language also uses it
      // as a keyword (`if (`, `for (`) — so keywords win, and everything else before `(` is a call.
      const after = src[i + word.length];
      if (words.has(key)) out += paint(word, 'keyword');
      else if (literals.has(key) || literals.has(word)) out += paint(word, 'literal');
      else if (after === '(') out += paint(word, 'func');
      else out += word;
      i += word.length;
      continue;
    }

    out += ch;
    i++;
  }
  return { text: out, inComment: false };
}

/** True when the path resolves to a language this module can colour. */
export function canHighlight(p) {
  const L = langForPath(p);
  return !!(L && (L.words.length || L.quotes));
}

