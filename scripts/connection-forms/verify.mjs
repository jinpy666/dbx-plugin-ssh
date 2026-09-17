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

assert.equal(byKey.advanced_options.type, "boolean");
assert.equal(byKey.advanced_options.binding, "config");
assert.equal(byKey.advanced_options.default, false, "advanced_options: must default to off");
const advancedFields = [
  "sudo_source", "connect_timeout_secs", "keepalive_interval_secs",
  "terminal_keepalive_secs", "set_env", "triggers_enabled",
  "passphrase_command", "remote_command", "read_only",
];
for (const key of advancedFields) {
  assert.deepEqual(byKey[key].visible_when, { field: "advanced_options", one_of: ["true"] },
    `${key}: must be gated by advanced_options`);
}

for (const advanced_options of [false, true]) {
  for (const authentication of options("authentication")) {
    for (const password_source of options("password_source")) {
      for (const sudo_source of options("sudo_source")) {
        for (const auth_flow_mode of options("auth_flow_mode")) {
          for (const read_only of [false, true]) {
            const current = state({ advanced_options, authentication, password_source, sudo_source, auth_flow_mode, read_only });
            const passwordAuth = ["password", "private-key-password"].includes(authentication);
            const privateKey = ["private-key", "private-key-password"].includes(authentication);
            // The login password is an explicit either-or: "Enter in this form"
            // requires the Password field, "Local command" requires Password
            // command. The user-chosen source is what makes strict validation
            // possible at all (a single-field `required_when` cannot say
            // "required unless password_command is set").
            const direct = password_source === "direct";
            current.visible("password_source", passwordAuth);
            current.visible("password", passwordAuth && direct);
            current.required("password", passwordAuth && direct);
            current.visible("password_command", passwordAuth && !direct);
            current.required("password_command", passwordAuth && !direct);
            // Same either-or shape for key material: a path or pasted content
            // is enough, so neither field may become form-required.
            current.visible("private_key_path", privateKey); current.required("private_key_path", false);
            current.required("private_key", false);
            current.visible("private_key_passphrase", privateKey); current.required("private_key_passphrase", false);
            current.visible("agent_socket", authentication === "agent");
            current.visible("sudo_password", advanced_options && sudo_source === "custom");
            current.visible("sudo_profile", advanced_options && sudo_source === "global");
            current.visible("auth_flow_mode", advanced_options && sudo_source !== "global");
            // TOTP secret/hint only apply to modes that answer OTP prompts;
            // "off" (manual 2FA) and "password_only" hide both.
            const answersOtp = ["password_then_otp", "password_plus_otp"].includes(auth_flow_mode);
            current.visible("totp_secret", advanced_options && sudo_source !== "global" && answersOtp);
            current.visible("totp_prompt_hint", advanced_options && sudo_source !== "global" && answersOtp);
            current.visible("triggers_enabled", advanced_options);
            current.visible("passphrase_command", advanced_options);
            current.visible("remote_command", advanced_options);
            current.visible("read_only", advanced_options);
          }
        }
      }
    }
  }
}

assert.equal(byKey.sudo_whitelist.type, "textarea");

// ---------------------------------------------------------------------------
// Credential contract: what the form must not require, and what it must say.
//
// The host enforces these rules twice — in the dialog (`pluginFieldConditions`
// + `ConnectionDialog.connectionConfigForSubmit`, which surfaces
// `connection.pluginRequiredField` = "请填写{field}") and again on
// test/connect in Rust (`validate_plugin_connection_values_for_action`, which
// additionally checks value types, the `port` binding range, and that every
// stored `connection_secrets` key is declared as a secret field). The manifest
// can only express a single-field `required_when`, which cannot say "required
// unless another field is set". So each either-or either gets an explicit
// user-facing selector, or it stays parse-time:
//   * password auth:  `password_source` = direct → Password required,
//                     `password_source` = command → Password command required
//                     (old configs without the selector keep the OR semantics
//                     in `from_lifecycle_params`, so nothing breaks silently);
//   * private key:    private_key_path OR private_key (pasted content) - no
//                     selector yet, so neither half may become form-required.
// A form that requires one half of a selector-less either-or blocks a
// configuration the sidecar accepts (dead footer, no explanation).
// ---------------------------------------------------------------------------
assert.equal(byKey.password_source.type, "select");
assert.equal(byKey.password_source.binding, "config");
assert.equal(byKey.password_source.default, "direct", "password_source: must default to the common case");
assert.deepEqual(options("password_source").sort(), ["command", "direct"]);
assert.deepEqual(byKey.password.required_when, { field: "password_source", one_of: ["direct"] });
assert.deepEqual(byKey.password.visible_when, { field: "password_source", one_of: ["direct"] });
assert.deepEqual(byKey.password_command.required_when, { field: "password_source", one_of: ["command"] });
assert.deepEqual(byKey.password_command.visible_when, { field: "password_source", one_of: ["command"] });
// Every password_source option must be covered by exactly one required branch:
// a gap means a save that the parser then rejects, an overlap means a dead end.
assert.deepEqual(
  [...byKey.password.required_when.one_of, ...byKey.password_command.required_when.one_of].sort(),
  options("password_source").slice().sort(),
  "password_source branches must cover every option",
);
for (const key of ["private_key_path", "private_key", "private_key_passphrase"]) {
  assert.equal(byKey[key].required_when, undefined, `${key}: must not be form-required (either-or credential)`);
}
for (const key of ["password_source", "password", "password_command", "private_key_path", "private_key", "port"]) {
  for (const locale of locales) {
    const localized = manifest.localizations[locale]?.contributions?.[provider.id]?.fields?.[key]
      ?? (locale === "en" ? byKey[key] : undefined);
    assert(localized?.description?.trim(), `${locale}/${key}: missing description for the credential/range contract`);
  }
}
// Port values are validated by the host Rust layer (1..65535) and by the
// sidecar; the contract has no min/max attribute, so the range hint must
// survive in the description text of every locale.
for (const locale of locales) {
  const localized = manifest.localizations[locale]?.contributions?.[provider.id]?.fields?.port
    ?? (locale === "en" ? byKey.port : undefined);
  assert(/1\D*65535/.test(String(localized.description)), `${locale}/port: 1-65535 hint missing from description`);
}
assert.equal(byKey.port.default, 22, "port: default must stay the documented 22");
state({ advanced_options: false, authentication: "password" }).visible("password", true);
state({ advanced_options: false, authentication: "private-key" }).visible("password", false);

// ---------------------------------------------------------------------------
// Private key file action (`picker`, Host API 1.1).
//
// Desktop hosts open the native dialog and store the chosen absolute path in
// `private_key_path`; hosts without a client filesystem (Web/Docker) cannot
// resolve such a path, so the same action uploads the file content into
// `private_key`, which the sidecar already prefers over the path
// (`resolve_private_key_text`). The pairing must therefore point at the
// secret-bound field - a config-bound target would write key material into
// `external_config` in plain text - and `accept` must stay unset: private keys
// are commonly named `id_rsa` / `id_ed25519` without an extension, and a native
// dialog filter greys those out instead of offering them.
//
// `picker` is additive but not forward compatible: hosts whose field parser
// predates it reject the whole manifest (`deny_unknown_fields`). The
// `engines.dbx` floor therefore has to move to the release that ships it before
// this manifest is published - but the value cannot be guessed ahead of time (a
// host built from the feature branch still reports the previous version), and
// bumping it early would block exactly the local end-to-end check the attribute
// exists for. It also cannot protect older hosts: parsing fails before the
// version check runs. So this stays a release-time step, asserted only for
// shape here.
// ---------------------------------------------------------------------------
assert.equal(byKey.private_key_path.binding, "config", "the picked path is stored in external_config");
assert.equal(
  byKey.private_key_path.options_action,
  "keys/discover/options",
  "picker must stack on top of the sidecar discovery dropdown, not replace it",
);
assert.deepEqual(
  byKey.private_key_path.picker,
  { kind: "file", content_field: "private_key" },
  "private_key_path: picker must select a file and feed the pasted-key field",
);
const pickerContentKey = byKey.private_key_path.picker.content_field;
assert(byKey[pickerContentKey], `picker content_field '${pickerContentKey}' must be a declared sibling`);
assert.equal(byKey[pickerContentKey].binding, "secret", "uploaded key content must land in the secret store");
assert.equal(byKey[pickerContentKey].type, "textarea", "uploaded key content is multi-line key material");
assert.equal(
  byKey.private_key_path.picker.accept,
  undefined,
  "picker.accept must stay unset so extension-less keys (id_rsa, id_ed25519) stay selectable",
);
const dbxFloor = String((manifest.engines || {}).dbx || "");
assert(
  /^>=\d+\.\d+\.\d+$/.test(dbxFloor),
  `engines.dbx must stay a plain '>=x.y.z' floor (got '${dbxFloor}')`,
);
console.log(
  `NOTE SSH connection form: 'picker' only parses on hosts that ship it — raise engines.dbx (currently ${dbxFloor}) to that release in the release commit.`,
);
// Both halves of the either-or must keep pointing at each other in every
// locale: the file action only makes sense if the text also names where an
// upload lands (Web/Docker) and that the two sources are exclusive.
for (const locale of locales) {
  for (const key of ["private_key_path", "private_key"]) {
    const localized = manifest.localizations[locale]?.contributions?.[provider.id]?.fields?.[key]
      ?? (locale === "en" ? byKey[key] : undefined);
    assert(localized?.description?.trim(), `${locale}/${key}: missing description`);
    assert(
      String(localized.description).includes("Web/Docker"),
      `${locale}/${key}: description must document the Web/Docker upload path`,
    );
  }
}

// Package B: ssh/trigger + external password manager fields (manifest §2.2).
// Triggers are one tssh/JSON text area gated by a separate, default-off switch.
const TRIGGER_FIELDS = ["triggers_enabled", "triggers", "trigger_answer_1", "trigger_answer_2", "password_command", "passphrase_command"];
const TRIGGER_TYPES = {
  triggers_enabled: "boolean",
  triggers: "textarea",
  trigger_answer_1: "password",
  trigger_answer_2: "password",
  password_command: "text",
  passphrase_command: "text",
};
const TRIGGER_BINDINGS = {
  triggers_enabled: "config",
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
  assert(field.description?.trim(), `${key}: base description required`);
  assert(fields.indexOf(field) < fields.indexOf(byKey.remote_command),
    `${key}: must sit near set_env (before remote_command)`);
}
assert.equal(byKey.triggers_enabled.default, false, "triggers_enabled: must default to off");
assert.deepEqual(byKey.triggers.visible_when, { field: "triggers_enabled", one_of: ["true"] });
for (const key of ["triggers", "trigger_answer_1", "trigger_answer_2"]) {
  assert.deepEqual(byKey[key].visible_when, { field: "triggers_enabled", one_of: ["true"] },
    `${key}: must be gated by triggers_enabled`);
}
// The triggers placeholder must be a usable tssh (trzsz-ssh) text example so
// copy-paste just works (the backend parses tssh text rules natively; the
// JSON form remains available alongside).
const placeholderExample = String(byKey.triggers.placeholder);
assert(placeholderExample.includes("ExpectCount"), "triggers.placeholder: expected a tssh ExpectCount example");
assert(placeholderExample.includes("ExpectPattern1"), "triggers.placeholder: expected ExpectPattern1");
assert(placeholderExample.includes("ExpectSendText1"), "triggers.placeholder: expected ExpectSendText1");
// Descriptions (risk + placeholder docs) must be provided in all seven locales.
for (const key of TRIGGER_FIELDS) {
  for (const locale of locales) {
    const localized = manifest.localizations[locale]?.contributions?.[provider.id]?.fields?.[key]
      ?? (locale === "en" ? byKey[key] : undefined);
    assert(localized?.description?.trim(), `${locale}/${key}: missing description`);
  }
}
state({ advanced_options: false, triggers_enabled: false }).visible("triggers", false);
state({ advanced_options: false, triggers_enabled: false }).visible("trigger_answer_1", false);
state({ advanced_options: false, triggers_enabled: false }).visible("trigger_answer_2", false);
state({ advanced_options: true, triggers_enabled: false }).visible("triggers", false);
state({ advanced_options: true, triggers_enabled: false }).visible("trigger_answer_1", false);
state({ advanced_options: true, triggers_enabled: false }).visible("trigger_answer_2", false);
state({ advanced_options: true, triggers_enabled: true }).visible("triggers", true);
state({ advanced_options: true, triggers_enabled: true }).visible("trigger_answer_1", true);
state({ advanced_options: true, triggers_enabled: true }).visible("trigger_answer_2", true);
state({ advanced_options: false }).visible("passphrase_command", false);
state({ advanced_options: true }).visible("passphrase_command", true);
// Password command lives in the credential block now: it is driven by the
// password source and no longer by the advanced switch.
state({ advanced_options: false, authentication: "password", password_source: "command" }).visible("password_command", true);
state({ advanced_options: false, authentication: "password", password_source: "direct" }).visible("password_command", false);
state({ advanced_options: false, authentication: "private-key", password_source: "command" }).visible("password_command", false);
console.log(`PASS SSH connection form: ${scenarios} combinations; field ordering and seven-language labels/options`);
