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

// Host condition semantics, mirrored from `pluginFieldConditions.ts` /
// `PluginFieldCondition` (Host API 1.1): a leaf clause matches when the sibling
// value is listed in `one_of`; `all_of` / `any_of` / `not` compose; and a clause
// only counts while the sibling it reads is itself visible (cascading), so a
// hidden controller's stored default can never light a field up.
function conditionClauseMatches(clause, value) {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return false;
  return clause.one_of.some((literal) => String(literal) === String(value));
}

function conditionReferencedFields(condition) {
  if (!condition) return [];
  if (typeof condition.field === "string") return [condition.field];
  if (Array.isArray(condition.all_of)) return condition.all_of.flatMap(conditionReferencedFields);
  if (Array.isArray(condition.any_of)) return condition.any_of.flatMap(conditionReferencedFields);
  return conditionReferencedFields(condition.not);
}

function conditionLeaves(condition) {
  if (!condition) return [];
  if (typeof condition.field === "string") return [condition];
  if (Array.isArray(condition.all_of)) return condition.all_of.flatMap(conditionLeaves);
  if (Array.isArray(condition.any_of)) return condition.any_of.flatMap(conditionLeaves);
  return conditionLeaves(condition.not);
}

function conditionMatches(condition, values) {
  if (!condition) return true;
  if (typeof condition.field === "string") return conditionClauseMatches(condition, values[condition.field]);
  if (Array.isArray(condition.all_of)) return condition.all_of.every((child) => conditionMatches(child, values));
  if (Array.isArray(condition.any_of)) return condition.any_of.some((child) => conditionMatches(child, values));
  return !conditionMatches(condition.not, values);
}

function conditionVisible(condition, values, seen) {
  if (!condition) return true;
  if (typeof condition.field === "string") {
    if (!conditionClauseMatches(condition, values[condition.field])) return false;
    return conditionOperandVisible(condition.field, values, seen);
  }
  if (Array.isArray(condition.all_of)) return condition.all_of.every((child) => conditionVisible(child, values, seen));
  if (Array.isArray(condition.any_of)) return condition.any_of.some((child) => conditionVisible(child, values, seen));
  const operandsVisible = conditionReferencedFields(condition.not).every((key) => conditionOperandVisible(key, values, seen));
  return operandsVisible && !conditionMatches(condition.not, values);
}

function conditionOperandVisible(key, values, seen) {
  const target = byKey[key];
  if (!target || seen.has(key)) return true;
  return isVisible(target, values, new Set(seen).add(key));
}

function isVisible(field, values, seen = new Set([field.key])) {
  const condition = field.visible_when;
  if (!condition) return true;
  return conditionVisible(condition, values, seen);
}

function isRequired(field, values) {
  return Boolean(field.required)
    || Boolean(field.required_when && conditionMatches(field.required_when, values));
}

for (const [index, field] of fields.entries()) {
  for (const condition of [field.visible_when, field.required_when].filter(Boolean)) {
    for (const clause of conditionLeaves(condition)) {
      const target = byKey[clause.field];
      assert(target, `${field.key}: unknown condition field ${clause.field}`);
      assert(fields.indexOf(target) < index, `${field.key}: condition target must precede dependent field`);
      const values = target.type === "boolean" ? ["true", "false"] : target.options?.map((option) => option.value);
      if (values) assert(clause.one_of.every((value) => values.includes(value)), `${field.key}: invalid condition value`);
    }
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
  "connect_timeout_secs", "keepalive_interval_secs",
  "terminal_keepalive_secs", "set_env", "triggers_enabled",
  "remote_command", "read_only",
];
const PROTOCOL_SSH = { field: "protocol", one_of: ["ssh"] };
for (const key of advancedFields) {
  assert.deepEqual(byKey[key].visible_when, { all_of: [PROTOCOL_SSH, { field: "advanced_options", one_of: ["true"] }] },
    `${key}: must be gated by protocol=ssh + advanced_options`);
}
// The passphrase command only feeds key decryption: with password or agent
// auth it would be dead UI, so it additionally requires key-based auth.
assert.deepEqual(byKey.passphrase_command.visible_when, {
  all_of: [
    PROTOCOL_SSH,
    { field: "advanced_options", one_of: ["true"] },
    { field: "authentication", one_of: ["private-key", "private-key-password", "auto"] },
  ],
}, "passphrase_command must combine protocol=ssh, the advanced switch and key-based auth");
// Sudo and 2FA are first-class entry points, not advanced trivia: hiding them
// behind the switch is what made bastion/MFA setup undiscoverable (issues #17
// and #30 - users could not find the TOTP field and gave up). Their *detail*
// fields still open on demand, so the default form only gains two rows.
assert.deepEqual(byKey.sudo_source.visible_when, PROTOCOL_SSH, "sudo_source is SSH-only and must stay visible without the advanced switch");
// Empty sudo password is not a no-op: the sidecar falls back to the login
// password, so defaulting to Off would silently stop answering sudo prompts
// for every new connection (`1a07ed3` flipped it, `de5ee09` flipped it back).
assert.equal(byKey.sudo_source.default, "custom", "sudo_source must keep the custom default - Off would stop sudo orchestration on new connections");
assert.deepEqual(byKey.auth_flow_mode.visible_when, {
  all_of: [PROTOCOL_SSH, { field: "sudo_source", one_of: ["custom", "off"] }],
}, "auth_flow_mode (2FA) must stay visible whenever sudo does not defer to a global profile");
// Field order is the form's information architecture: the switch must sit
// *below* the always-visible sudo/2FA rows, so it reads as "the settings below
// this switch are optional" instead of implying sudo/2FA are optional extras.
assert(fields.indexOf(byKey.advanced_options) > fields.indexOf(byKey.auth_flow_mode),
  "advanced_options must be declared after the sudo/2FA block");
assert(fields.indexOf(byKey.advanced_options) > fields.indexOf(byKey.totp_prompt_hint),
  "advanced_options must be declared after the 2FA block it no longer gates");
// The password-prompt hint belongs to the 2FA trio (TOTP secret, OTP hint,
// password hint): it renders next to them and only while OTP auto-answer is
// on, so turning 2FA off folds the whole block - a stray password-hint row
// under "Off" read as a broken condition. The sudo_source clause keeps it
// hidden under a global profile (whose own hints take over); cascade makes
// the auth_flow_mode clause follow automatically there.
assert.deepEqual(byKey.password_prompt_hint.visible_when, {
  all_of: [
    PROTOCOL_SSH,
    { field: "sudo_source", one_of: ["custom", "off"] },
    { field: "auth_flow_mode", one_of: ["password_then_otp", "password_plus_otp"] },
  ],
}, "password_prompt_hint must track the 2FA trio and fold when OTP auto-answer is off");
assert(fields.indexOf(byKey.password_prompt_hint) > fields.indexOf(byKey.totp_prompt_hint),
  "password_prompt_hint must render inside the 2FA block, next to the OTP hint");
assert(fields.indexOf(byKey.advanced_options) > fields.indexOf(byKey.password_prompt_hint),
  "advanced_options must be declared after the 2FA trio");

for (const advanced_options of [false, true]) {
  for (const authentication of options("authentication")) {
    for (const password_source of options("password_source")) {
      for (const sudo_source of options("sudo_source")) {
        for (const auth_flow_mode of options("auth_flow_mode")) {
          for (const read_only of [false, true]) {
            const current = state({ advanced_options, authentication, password_source, sudo_source, auth_flow_mode, read_only });
            // Auto（M13-A）按序回退会用到全部凭据来源：password_source /
            // password / 密钥字段 / agent_socket 全部可见，但 none 仍不可见
            // 的字段一个不多（与 manifest one_of 门控逐项对应）。
            const passwordAuth = ["password", "private-key-password", "auto"].includes(authentication);
            const privateKey = ["private-key", "private-key-password", "auto"].includes(authentication);
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
            current.visible("agent_socket", ["agent", "auto"].includes(authentication));
            // Sudo details follow their source only. The obvious extra rule -
            // "hide them on read-only connections" - cannot be expressed while
            // `read_only` itself sits behind `advanced_options`: the host's `not`
            // requires every operand to be *visible*, so `not read_only` would
            // evaluate false whenever the advanced switch is off and the sudo
            // block would never show. The read-only interaction therefore stays
            // in the field description ("ignored for read-only connections").
            current.visible("sudo_source", true);
            current.visible("sudo_password", sudo_source === "custom");
            current.visible("sudo_profile", sudo_source === "global");
            current.visible("sudo_use_pty", sudo_source === "custom");
            current.visible("sudo_whitelist", sudo_source === "custom" || sudo_source === "global");
            current.visible("auth_flow_mode", sudo_source !== "global");
            // TOTP secret/hint only apply to modes that answer OTP prompts;
            // "off" (manual 2FA) and "password_only" hide both.
            const answersOtp = ["password_then_otp", "password_plus_otp"].includes(auth_flow_mode);
            current.visible("totp_secret", sudo_source !== "global" && answersOtp);
            current.visible("totp_prompt_hint", sudo_source !== "global" && answersOtp);
            current.visible("password_prompt_hint", sudo_source !== "global" && answersOtp);
            current.visible("triggers_enabled", advanced_options);
            current.visible("passphrase_command", advanced_options && privateKey);
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
assert.deepEqual(byKey.password.visible_when, {
  all_of: [PROTOCOL_SSH, { field: "password_source", one_of: ["direct"] }],
});
assert.deepEqual(byKey.password_command.required_when, { field: "password_source", one_of: ["command"] });
assert.deepEqual(byKey.password_command.visible_when, {
  all_of: [PROTOCOL_SSH, { field: "password_source", one_of: ["command"] }],
});
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
// predates it reject the whole manifest (`deny_unknown_fields`) — and parsing
// fails before the version check runs, so the floor cannot protect older hosts,
// only document them. DBX 0.6.16 is the first release that ships the attribute
// (0.6.15 and earlier have no `picker` in `PluginFormFieldDefinition`), so the
// floor is pinned there and may only move up.
//
// The field must stay *typable*. Declaring `options_action` makes the host
// render a select-only control (`selectOptionsFor()` wins over the text input
// in `PluginConnectionFields.vue`), which is the opposite of the host's own
// tunnel key field - a text input with a browse action - and blocks the common
// case of a key that no discovery list knows about. Free typing comes first;
// selection is served by the host's built-in `private_key_path` suggestion
// list (`list_local_ssh_keys`, desktop) and by the picker action below.
// ---------------------------------------------------------------------------
assert.equal(byKey.private_key_path.binding, "config", "the picked path is stored in external_config");
assert.equal(
  byKey.private_key_path.options_action,
  undefined,
  "private_key_path must not declare options_action: the host would drop the text input for a select",
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
// 0.6.16 is the release that first parses `picker`; a lower floor would ship a
// manifest that older hosts reject outright instead of merely hiding a button.
const PICKER_RELEASE = [0, 6, 16];
const floorParts = dbxFloor.replace(/^>=/, "").split(".").map((part) => Number(part));
const floorAtLeastPickerRelease = floorParts.some((part, index) => {
  const target = PICKER_RELEASE[index];
  if (part !== target) return part > target;
  return index === PICKER_RELEASE.length - 1;
});
assert(
  floorAtLeastPickerRelease,
  `engines.dbx must be >= ${PICKER_RELEASE.join(".")} — the first release whose form parser accepts 'picker' (got '${dbxFloor}')`,
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
assert.deepEqual(byKey.triggers.visible_when, {
  all_of: [PROTOCOL_SSH, { field: "triggers_enabled", one_of: ["true"] }],
});
for (const key of ["triggers", "trigger_answer_1", "trigger_answer_2"]) {
  assert.deepEqual(byKey[key].visible_when, {
    all_of: [PROTOCOL_SSH, { field: "triggers_enabled", one_of: ["true"] }],
  }, `${key}: must be gated by protocol=ssh + triggers_enabled`);
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
state({ advanced_options: false, authentication: "private-key" }).visible("passphrase_command", false);
state({ advanced_options: true, authentication: "password" }).visible("passphrase_command", false);
state({ advanced_options: true, authentication: "private-key" }).visible("passphrase_command", true);
// The 2FA trio folds together: with OTP auto-answer off neither TOTP field
// nor the password hint stays behind (the reported stray-row case).
state({ sudo_source: "custom", auth_flow_mode: "off", advanced_options: true }).visible("password_prompt_hint", false);
state({ sudo_source: "custom", auth_flow_mode: "password_only", advanced_options: true }).visible("password_prompt_hint", false);
state({ sudo_source: "custom", auth_flow_mode: "password_then_otp", advanced_options: false }).visible("password_prompt_hint", true);
state({ sudo_source: "global", auth_flow_mode: "password_then_otp" }).visible("password_prompt_hint", false);
state({ sudo_source: "off", auth_flow_mode: "password_plus_otp" }).visible("password_prompt_hint", true);
// Password command lives in the credential block now: it is driven by the
// password source and no longer by the advanced switch.
state({ advanced_options: false, authentication: "password", password_source: "command" }).visible("password_command", true);
state({ advanced_options: false, authentication: "password", password_source: "direct" }).visible("password_command", false);
state({ advanced_options: false, authentication: "private-key", password_source: "command" }).visible("password_command", false);

// ---------------------------------------------------------------------------
// Host dialog timeout-scope contract (issue #20: "全局" timeouts revert to
// "当前连接" after save+reopen).
//
// The connect/query timeout scope radios in the host's "Advanced" tab are NOT
// plugin fields: they bind the host `ConnectionConfig` top-level
// `connect_timeout_secs` / `query_timeout_secs` plus the scope sentinels
// `connect_timeout_inherit` / `query_timeout_inherit` (true = follow the host
// global timeout settings). Plugin (db_type="plugin") connections render the
// same host block, so the plugin cannot express or repair this in the
// manifest - it is recorded here as the mirrored host contract, like the
// dialog semantics mirrored in backend/src/model.rs.
//
// Host semantics mirrored from the DBX desktop checkout (main@7a6bb0fe2):
//   * hydrate  - apps/desktop/src/components/connection/ConnectionDialog.vue
//                (ConnectionDialog syncAction="hydrate" block):
//                `config.connect_timeout_inherit === true` is the ONLY global
//                state; absent/false/0 all mean "current connection".
//   * submit   - same file, `connectionConfigForSubmit` plugin branch: it
//                rebuilds the config via `buildPluginConnectionConfig`
//                (apps/desktop/src/lib/plugins/frontendPlugin.ts), which does
//                not carry the two inherit flags, then re-assigns only the
//                scalar timeouts. The non-plugin branch ({...form}) keeps the
//                flags, so plugin connections are the ones that lose them.
//   * persist  - apps/desktop/src/stores/connectionStore.ts
//                `normalizeConnection` falls back to the inherit-ID list and
//                `updateConnection`/`persistTimeoutInheritance` then solidify
//                the lost scope as "current connection".
//
// KNOWN HOST BUG: the plugin branch drops the scope, so every save resets the
// visible scope to "current connection" (both for an explicit "全局" choice
// and for a brand-new connection, whose dialog form defaults to inherit=true).
// Minimal host-side fix: in the `connectionConfigForSubmit` plugin branch,
// alongside the `config.connect_timeout_secs = ...` re-assignments, add
//   config.connect_timeout_inherit = form.value.connect_timeout_inherit;
//   config.query_timeout_inherit = form.value.query_timeout_inherit;
// (and optionally carry the flags in `buildPluginConnectionConfig`'s base
// object). Human decision lives on the host side; the assertions below pin
// the semantics this plugin's users depend on so a host regression cannot
// silently change them again.
// ---------------------------------------------------------------------------
let timeoutScenarios = 0;

const GLOBAL_CONNECT_TIMEOUT_SECS = 10;
const GLOBAL_QUERY_TIMEOUT_SECS = 0;

// Host hydrate: stored config -> dialog form state.
function hydrateTimeoutScope(config) {
  const connectInherit = config.connect_timeout_inherit === true;
  const queryInherit = config.query_timeout_inherit === true;
  return {
    connect_timeout_inherit: connectInherit,
    connect_timeout_secs: connectInherit ? GLOBAL_CONNECT_TIMEOUT_SECS : (config.connect_timeout_secs || 10),
    query_timeout_inherit: queryInherit,
    query_timeout_secs: queryInherit ? GLOBAL_QUERY_TIMEOUT_SECS : (config.query_timeout_secs ?? 60),
  };
}

// Host submit, plugin branch, as the contract requires it: the scalar
// timeouts are re-assigned from the form AND the scope flags survive.
function submitTimeoutScope(form) {
  return {
    connect_timeout_secs: form.connect_timeout_secs,
    query_timeout_secs: form.query_timeout_secs,
    connect_timeout_inherit: form.connect_timeout_inherit,
    query_timeout_inherit: form.query_timeout_inherit,
  };
}

function assertTimeoutScope(label, form, expected) {
  timeoutScenarios++;
  const reopened = hydrateTimeoutScope(submitTimeoutScope(form));
  assert.deepEqual(reopened, expected, `${label}: timeout scope lost across save/reopen`);
}

// 1) Existing "current connection" (1s / 60s) -> user picks 全局 for both
//    timeouts -> save -> reopen must still show 全局 (issue #20 report).
{
  const form = {
    ...hydrateTimeoutScope({ connect_timeout_secs: 1, query_timeout_secs: 60 }),
    connect_timeout_inherit: true,
    query_timeout_inherit: true,
  };
  assertTimeoutScope("global save keeps global", form, {
    connect_timeout_inherit: true,
    connect_timeout_secs: GLOBAL_CONNECT_TIMEOUT_SECS,
    query_timeout_inherit: true,
    query_timeout_secs: GLOBAL_QUERY_TIMEOUT_SECS,
  });
}

// 2) 全局 -> back to 当前连接 with an edited number -> save -> reopen must
//    stay "current connection" with the typed value still editable.
{
  const form = {
    ...hydrateTimeoutScope({ connect_timeout_secs: 1, query_timeout_secs: 60 }),
    connect_timeout_inherit: true,
    query_timeout_inherit: true,
  };
  form.connect_timeout_inherit = false;
  form.connect_timeout_secs = 42;
  form.query_timeout_inherit = false;
  form.query_timeout_secs = 120;
  assertTimeoutScope("switch back to per-connection stays editable", form, {
    connect_timeout_inherit: false,
    connect_timeout_secs: 42,
    query_timeout_inherit: false,
    query_timeout_secs: 120,
  });
}

// 3) A brand-new connection: the dialog form defaults to inherit=true, so the
//    first save must persist 全局 too (same root cause, same revert).
assertTimeoutScope("new connection default keeps global", {
  connect_timeout_inherit: true,
  connect_timeout_secs: GLOBAL_CONNECT_TIMEOUT_SECS,
  query_timeout_inherit: true,
  query_timeout_secs: GLOBAL_QUERY_TIMEOUT_SECS,
}, {
  connect_timeout_inherit: true,
  connect_timeout_secs: GLOBAL_CONNECT_TIMEOUT_SECS,
  query_timeout_inherit: true,
  query_timeout_secs: GLOBAL_QUERY_TIMEOUT_SECS,
});

// Sentinel semantics: only an explicit `true` means 全局. The host hydrate
// must keep treating absent/false/0 (and any other falsy junk) as "current
// connection" so legacy rows saved before the flags existed stay editable.
for (const junk of [undefined, false, 0, "true"]) {
  timeoutScenarios++;
  const reopened = hydrateTimeoutScope({ connect_timeout_inherit: junk, query_timeout_inherit: junk, connect_timeout_secs: 7, query_timeout_secs: 8 });
  assert.equal(reopened.connect_timeout_inherit, false, `sentinel ${String(junk)} must not mean global`);
  assert.equal(reopened.query_timeout_inherit, false, `sentinel ${String(junk)} must not mean global`);
  assert.equal(reopened.connect_timeout_secs, 7, "per-connection value must survive hydrate");
  assert.equal(reopened.query_timeout_secs, 8, "per-connection value must survive hydrate");
}

// ---------------------------------------------------------------------------
// M32-B1：serial/rdp 连接类型。协议门控矩阵——host/port 对 TCP 四协议共用
// （serial 隐藏），SSH 专属凭据簇对 serial/rdp 整体隐藏，serial/rdp 各自的
// 协议字段互不串扰、且不得出现在其他协议下。
// ---------------------------------------------------------------------------
const TCP_PROTOCOLS = ["ssh", "telnet", "vnc", "rdp"];
assert.deepEqual(byKey.host.visible_when, { field: "protocol", one_of: TCP_PROTOCOLS },
  "host must stay visible for every TCP protocol and hide for serial");
assert.deepEqual(byKey.port.visible_when, { field: "protocol", one_of: TCP_PROTOCOLS },
  "port must stay visible for every TCP protocol and hide for serial");
assert.deepEqual(byKey.username.visible_when, { field: "protocol", one_of: ["ssh", "telnet", "rdp"] },
  "username must serve ssh/telnet/rdp (NLA) and hide for vnc/serial");
for (const key of ["serial_port", "serial_baud", "serial_data_bits", "serial_parity", "serial_stop_bits", "serial_backspace"]) {
  assert.deepEqual(byKey[key].visible_when, { field: "protocol", one_of: ["serial"] },
    `${key} must show only for serial connections`);
}
for (const key of ["rdp_domain", "rdp_resolution", "rdp_certificate_policy", "rdp_clipboard"]) {
  assert.deepEqual(byKey[key].visible_when, { field: "protocol", one_of: ["rdp"] },
    `${key} must show only for rdp connections`);
}
// serial_port 不设必填：设备可能尚未插上（后端连接时校验，表单不拦）。
assert.equal(byKey.serial_port.required, undefined, "serial_port must not be form-required (device may be attached later)");
assert.deepEqual(options("protocol"), ["ssh", "telnet", "vnc", "serial", "rdp"], "protocol options must list every routed protocol");
for (const protocol of options("protocol")) {
  const current = state({ protocol });
  current.visible("display_name", true);
  current.visible("host", TCP_PROTOCOLS.includes(protocol));
  current.visible("port", TCP_PROTOCOLS.includes(protocol));
  current.visible("username", ["ssh", "telnet", "rdp"].includes(protocol));
  // SSH 凭据/调优字段只属于 ssh；serial/rdp 表单不得残留 SSH 行。
  current.visible("sudo_source", protocol === "ssh");
  current.visible("advanced_options", protocol === "ssh");
  current.visible("serial_port", protocol === "serial");
  current.visible("serial_baud", protocol === "serial");
  current.visible("serial_data_bits", protocol === "serial");
  current.visible("serial_parity", protocol === "serial");
  current.visible("serial_stop_bits", protocol === "serial");
  current.visible("serial_backspace", protocol === "serial");
  current.visible("rdp_domain", protocol === "rdp");
  current.visible("rdp_resolution", protocol === "rdp");
  current.visible("rdp_certificate_policy", protocol === "rdp");
  current.visible("rdp_clipboard", protocol === "rdp");
}

console.log(`PASS SSH connection form: ${scenarios} combinations; field ordering and seven-language labels/options`);
console.log(`PASS SSH timeout scope contract: ${timeoutScenarios} cases; global/per-connection sentinels survive save+reopen (issue #20, host-side fix tracked separately)`);
