// Standalone SSH connection-form contract verifier.
//
// The monorepo version imports the DBX host's TypeScript condition evaluator.
// This copy intentionally keeps only the small, host-compatible evaluator and
// SSH assertions needed by this repository, so clean clones do not need ../host
// or ../shared. Replace this file with the future public form-contract package
// when that package is available; keep the scenarios below as the SSH
// regression contract.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", root), "utf8"));
const provider = manifest.contributions.find((item) => item.type === "connection-provider");
assert(provider, "SSH manifest must define a connection provider");
const fields = provider.fields;
const byKey = Object.fromEntries(fields.map((field) => [field.key, field]));
const defaults = Object.fromEntries(fields.map((field) => [field.key, field.default]));
const locales = ["en", "zh-CN", "zh-TW", "es", "it", "ja", "pt-BR"];

assert.equal(new Set(fields.map((field) => field.key)).size, fields.length, "duplicate field keys");

function conditionMatches(condition, value) {
  if (!condition) return true;
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return false;
  return condition.one_of.includes(String(value));
}

function isVisible(field, values, seen = new Set([field.key])) {
  const condition = field.visible_when;
  if (!condition || !conditionMatches(condition, values[condition.field])) return !condition;
  const target = byKey[condition.field];
  if (!target || seen.has(target.key)) return true;
  seen.add(target.key);
  return isVisible(target, values, seen);
}

function isRequired(field, values) {
  return Boolean(field.required)
    || Boolean(field.required_when && conditionMatches(field.required_when, values[field.required_when.field]));
}

for (const [index, field] of fields.entries()) {
  for (const condition of [field.visible_when, field.required_when].filter(Boolean)) {
    const target = byKey[condition.field];
    assert(target, `${field.key}: unknown condition field ${condition.field}`);
    assert(fields.indexOf(target) < index, `${field.key}: condition target must precede dependent field`);
    const values = target.type === "boolean" ? ["true", "false"] : target.options?.map((option) => option.value);
    if (values) assert(condition.one_of.every((value) => values.includes(value)), `${field.key}: invalid condition value`);
  }
  if (field.type === "select" && field.default !== undefined) {
    assert(field.options.some((option) => option.value === field.default), `${field.key}: invalid default`);
  }
  for (const locale of locales) {
    const localized = manifest.localizations[locale]?.contributions?.[provider.id]?.fields?.[field.key]
      ?? (locale === "en" ? field : undefined);
    assert(localized?.label?.trim(), `${locale}/${field.key}: missing label`);
    for (const option of field.options ?? []) {
      const label = Array.isArray(localized.options)
        ? localized.options.find((item) => item.value === option.value)?.label
        : localized.options?.[option.value];
      assert(label?.trim(), `${locale}/${field.key}/${option.value}: missing option label`);
    }
  }
}

const options = (key) => byKey[key].options.map((option) => option.value);
let scenarios = 0;
function state(overrides) {
  scenarios++;
  const values = { ...defaults, ...overrides };
  const visible = new Set(fields.filter((field) => isVisible(field, values)).map((field) => field.key));
  const required = new Set(fields.filter((field) => visible.has(field.key) && isRequired(field, values)).map((field) => field.key));
  return {
    visible(key, expected) { assert.equal(visible.has(key), expected, `${key} visibility: ${JSON.stringify(overrides)}`); },
    required(key, expected) { assert.equal(required.has(key), expected, `${key} required: ${JSON.stringify(overrides)}`); },
  };
}

for (const authentication of options("authentication")) {
  for (const sudo_source of options("sudo_source")) {
    for (const auth_flow_mode of options("auth_flow_mode")) {
      for (const read_only of [false, true]) {
        const current = state({ authentication, sudo_source, auth_flow_mode, read_only });
        const password = ["password", "private-key-password"].includes(authentication);
        const privateKey = ["private-key", "private-key-password"].includes(authentication);
        current.visible("password", password); current.required("password", password);
        // The path is optional because the private_key secret field can carry
        // pasted OpenSSH/PEM/PPK content and takes precedence over the path.
        current.visible("private_key_path", privateKey); current.required("private_key_path", false);
        current.visible("private_key_passphrase", privateKey); current.required("private_key_passphrase", false);
        current.visible("agent_socket", authentication === "agent");
        current.visible("sudo_password", sudo_source === "custom");
        current.visible("sudo_profile", sudo_source === "global");
        current.visible("auth_flow_mode", sudo_source !== "global");
        // TOTP secret/hint only apply to modes that answer OTP prompts;
        // "off" (manual 2FA) and "password_only" hide both.
        const answersOtp = ["password_then_otp", "password_plus_otp"].includes(auth_flow_mode);
        current.visible("totp_secret", sudo_source !== "global" && answersOtp);
        current.visible("totp_prompt_hint", sudo_source !== "global" && answersOtp);
      }
    }
  }
}

assert.equal(byKey.sudo_whitelist.type, "textarea");

// Package B: ssh/trigger + external password manager fields (manifest §2.2).
// Key names, types and bindings are frozen by the implementation contract.
const TRIGGER_FIELDS = ["triggers", "trigger_answer_1", "trigger_answer_2", "password_command", "passphrase_command"];
const TRIGGER_TYPES = {
  triggers: "textarea",
  trigger_answer_1: "password",
  trigger_answer_2: "password",
  password_command: "text",
  passphrase_command: "text",
};
const TRIGGER_BINDINGS = {
  triggers: "config",
  trigger_answer_1: "secret",
  trigger_answer_2: "secret",
  password_command: "config",
  passphrase_command: "config",
};
for (const key of TRIGGER_FIELDS) {
  const field = byKey[key];
  assert(field, `missing ssh/trigger field ${key}`);
  assert.equal(field.type, TRIGGER_TYPES[key], `${key}: type changed`);
  assert.equal(field.binding, TRIGGER_BINDINGS[key], `${key}: binding changed`);
  assert.equal(field.visible_when, undefined, `${key}: must stay unconditional (no visible_when)`);
  assert(field.description?.trim(), `${key}: base description required`);
  assert(byKey.triggers && fields.indexOf(field) < fields.indexOf(byKey.remote_command),
    `${key}: must sit near set_env (before remote_command)`);
}
// The triggers placeholder must be valid JSON with a minimal usable stage
// example (one stage: pattern + sendText) so copy-paste just works.
const placeholderExample = JSON.parse(byKey.triggers.placeholder);
assert(Array.isArray(placeholderExample.stages) && placeholderExample.stages.length === 1,
  "triggers.placeholder: expected a one-stage example");
assert(typeof placeholderExample.stages[0].pattern === "string", "triggers.placeholder: pattern missing");
assert(typeof placeholderExample.stages[0].sendText === "string", "triggers.placeholder: sendText missing");
// Descriptions (risk + placeholder docs) must be provided in all seven locales.
for (const key of TRIGGER_FIELDS) {
  for (const locale of locales) {
    const localized = manifest.localizations[locale]?.contributions?.[provider.id]?.fields?.[key]
      ?? (locale === "en" ? byKey[key] : undefined);
    assert(localized?.description?.trim(), `${locale}/${key}: missing description`);
  }
}
// The new fields carry no visible_when: they stay visible in every option
// combination (any authentication / sudo_source / auth_flow_mode choice).
for (const key of TRIGGER_FIELDS) state({}).visible(key, true);
console.log(`PASS SSH connection form: ${scenarios} combinations; field ordering and seven-language labels/options`);
