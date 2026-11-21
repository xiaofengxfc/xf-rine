'use strict';

function envHas(text, name) {
  return new RegExp('^[ \\t]*' + name + '[ \\t]*=', 'm').test(text);
}

function readEnvNumber(text, name) {
  const match = new RegExp('^[ \\t]*' + name + '[ \\t]*=[ \\t]*(\\d+)', 'm').exec(text);
  return match ? Number(match[1]) : 0;
}

function readEnvString(text, name) {
  const match = new RegExp('^[ \\t]*' + name + '[ \\t]*=[ \\t]*(\\S+)', 'm').exec(text);
  return match ? match[1] : '';
}

function setEnvLine(text, name, value) {
  const line = name + '=' + value;
  const pattern = new RegExp('^[ \\t]*' + name + '[ \\t]*=.*$', 'm');
  return pattern.test(text)
    ? text.replace(pattern, line)
    : text.replace(/\s*$/, '') + (text.trim() ? '\n' : '') + line + '\n';
}

function withNetworkDefaults(text, token) {
  const additions = [];
  if (!envHas(text, 'HOST')) additions.push('HOST=0.0.0.0');
  if (!envHas(text, 'REMOTE_TOKEN')) additions.push('REMOTE_TOKEN=' + token);

  const nextText = additions.length
    ? text.replace(/\s*$/, '') + (text.trim() ? '\n' : '') + additions.join('\n') + '\n'
    : text;

  return {
    text: nextText,
    host: readEnvString(nextText, 'HOST') || '0.0.0.0',
  };
}

module.exports = { envHas, readEnvNumber, readEnvString, setEnvLine, withNetworkDefaults };
