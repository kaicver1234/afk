'use strict';

// Flattening of everything a Minecraft server might hand us — a mineflayer
// ChatMessage, a raw JSON chat string, a nested {text, extra:[...]} tree, or
// (1.20.3+ login-phase kicks, also Via*-translated joins) a prismarine-nbt
// chat component — into plain readable text.

const stripCodes = s => String(s)
  .replace(/\x1b\[[0-9;]*m/g, '')
  .replace(/§[0-9a-fk-or]/gi, '')
  .replace(/[ \t]+/g, ' ')
  .trim();

function readChat(input) {
  if (input == null) return '';
  let node = input;

  if (typeof node === 'string') {
    const s = node.trim();
    if (!s.startsWith('{') && !s.startsWith('[')) return stripCodes(s);
    try { node = JSON.parse(s); } catch (_) { return stripCodes(s); }
  }

  // mineflayer's ChatMessage renders the whole component tree itself.
  if (typeof node?.toAnsi === 'function') {
    try {
      const s = stripCodes(node.toAnsi());
      if (s) return s;
    } catch (_) {}
  }

  // Try toString() method if available
  if (typeof node?.toString === 'function' && node.toString !== Object.prototype.toString) {
    try {
      const s = stripCodes(node.toString());
      if (s && s !== '[object Object]') return s;
    } catch (_) {}
  }

  const walk = n => {
    if (n == null) return '';
    if (typeof n === 'string') return n;
    if (typeof n === 'number' || typeof n === 'boolean') return String(n);
    if (Array.isArray(n)) return n.map(walk).join('');
    // prismarine-nbt chat component (1.20.3+ login-phase kick reasons look
    // exactly like this): every node is {type: 'compound'|'list'|'string'|…,
    // value: …}. Without unwrapping here, the component used to flatten to its
    // `type` field — the literal word "compound" — which hid the real kick
    // reason from the user AND got matched by the antibot keyword checks that
    // read the flattened text, mislabelling every such kick as an antibot
    // rejection.
    if (typeof n.type === 'string' && n.value !== undefined) {
      return typeof n.value === 'string' ? n.value : walk(n.value);
    }
    let out = '';
    // A component's text/translate/reason/message may itself be a nested node
    // (e.g. {text: {type: 'string', value: '…'}} inside an nbt compound), so
    // recurse instead of requiring a plain string.
    if (n.text != null) out += typeof n.text === 'string' ? n.text : walk(n.text);
    else if (n.translate != null) out += typeof n.translate === 'string' ? n.translate : walk(n.translate);
    else if (n.reason != null) out += typeof n.reason === 'string' ? n.reason : walk(n.reason);
    else if (n.message != null) out += typeof n.message === 'string' ? n.message : walk(n.message);
    // with/extra in nbt form are {type:'list', value:[…]} objects, not arrays.
    const asList = v => Array.isArray(v) ? v
      : (typeof v?.type === 'string' && v.type === 'list' && Array.isArray(v.value)) ? v.value
      : null;
    const withList = asList(n.with);
    if (withList) out += ' ' + withList.map(walk).join(' ');
    const extraList = asList(n.extra);
    if (extraList) out += extraList.map(walk).join('');
    return out;
  };

  const flat = stripCodes(walk(node));
  if (flat) return flat;

  // Last resort: any string values on the object — but never the nbt `type`
  // tag, which is metadata about the component, not part of its message.
  try {
    if (typeof node === 'object') {
      const values = Object.entries(node)
        .filter(([k, v]) => k !== 'type' && typeof v === 'string')
        .map(([, v]) => v).join(' ');
      if (values) return stripCodes(values);
    }
    return stripCodes(String(node));
  } catch (_) { return ''; }
}

module.exports = { readChat, stripCodes };
