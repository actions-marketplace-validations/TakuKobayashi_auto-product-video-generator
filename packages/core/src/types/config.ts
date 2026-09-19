import { z } from 'zod';

export const VideoTypeSchema = z.enum(['teaser', 'shorts', 'demo', 'tutorial']);
export type VideoType = z.infer<typeof VideoTypeSchema>;

// What kind of project this is, as classified by AI from the actual source
// (see @auto-product-video-generator/ai's platform-classifier.ts for the prompt, and
// @auto-product-video-generator/source's inspector.ts for the deterministic file-based
// hints that ground that classification). Recorded in both
// project-summary.json and scenario.yml's meta.platform.
//
// Recording is selected by platform. Web uses Playwright; Android and
// Android builds from cross-platform projects use adb.
//
// To add a new platform: add it here, then add a one-line description to
// PLATFORM_DESCRIPTIONS in packages/ai/src/pipeline/platform-classifier.ts
// (and, ideally, a deterministic hint in packages/source/src/inspector.ts).
export const ProjectPlatformSchema = z.enum([
  'web',
  'cli',
  'ios',
  'android',
  'unity',
  'flutter',
  'react-native',
  'desktop',
  'other',
]);
export type ProjectPlatform = z.infer<typeof ProjectPlatformSchema>;
export const DEFAULT_PLATFORM_PRIORITY: ProjectPlatform[] = [
  'web',
  'cli',
  'android',
  'flutter',
  'react-native',
  'unity',
  'ios',
  'desktop',
  'other',
];
export const DEFAULT_CLI_DENIED_COMMAND_PATTERNS = [
  'publish',
  'login',
  'logout',
  'token',
  'secret',
  'clean',
  'remove',
  'delete',
  'serve',
  'start',
  'watch',
  'generate',
  'voice',
  'record',
  'render',
];

export const ProjectConfigSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

// Where the AI-facing project *source* comes from — this is what `analyze`
// reads (package.json, README, route/page files, platform signals) to
// understand what the app actually does. Source analysis also detects
// non-web platforms and selects a compatible recorder when available.
//
// Exactly one of `repository` / `localPath` must be set:
//   - repository: a git remote (https:// or git@ form). Shallow-cloned into
//     `<workDir>/source-repo`.
//   - localPath: a path to a project that's already checked out locally
//     (must itself be a git repository — this is not "any folder").
export const SourceConfigSchema = z
  .object({
    repository: z.string().optional(),
    localPath: z.string().optional(),
    ref: z.string().optional(), // branch / tag / commit; only meaningful with `repository`
    installDeps: z.boolean().default(false),
    // Optional environment file copied into the selected runnable project before
    // analysis/build/recording. Its contents are converted to the convention used
    // by that project (.env, Cloudflare .dev.vars, or Android local.properties).
    environmentFile: z.string().min(1).optional(),
    // Command to start the app's dev server, run from the source root
    // (e.g. "npm run dev", "pnpm run dev"). If set, the video recording
    // and generation commands will
    // automatically run it (installing deps first if `installDeps` is
    // true) whenever `target.url` isn't already reachable, instead of
    // requiring you to start it yourself in another terminal. Left unset
    // by default — `analyze` will suggest one it detects from
    // package.json's scripts (prefers "dev", falls back to "start") and
    // save it into apvg.config.yml for you to confirm/edit.
    startCommand: z.string().optional(),
    // Monorepo application selection. projectPath wins; otherwise runnable
    // workspace packages are ranked by this platform order, then app quality.
    projectPath: z.string().min(1).optional(),
    platformPriority: z.array(ProjectPlatformSchema).min(1).default(DEFAULT_PLATFORM_PRIORITY),
    // Additional gitignore-style patterns excluded from AI-facing source
    // inspection and from the temporary CLI recording workspace.
    exclude: z.array(z.string().min(1)).default([]),
  })
  .refine((data) => Boolean(data.repository) !== Boolean(data.localPath), {
    message: 'Specify exactly one of source.repository or source.localPath, not both/neither.',
  });
export type SourceConfig = z.infer<typeof SourceConfigSchema>;

// Where the app can actually be reached once it's running, so Playwright can
// record it. This is NOT the source location — you still need to start the
// dev server yourself (e.g. `npm run dev`) before `record`/`build` run.
export const WebAuthConfigSchema = z.object({
  // Manual browser login is the first supported flow. Future password/passkey
  // setup can produce the same Playwright storage-state file.
  mode: z.literal('manual').default('manual'),
  // Defaults to target.url when omitted.
  loginUrl: z.string().url().optional(),
  // Save automatically after the browser reaches this URL. Without it, the
  // user confirms login completion by pressing Enter in the terminal.
  successUrl: z.string().url().optional(),
  // Contains cookies/local storage/IndexedDB and must never be committed.
  storageStatePath: z.string().min(1).default('./.apvg/auth/storage-state.json'),
});
export type WebAuthConfig = z.infer<typeof WebAuthConfigSchema>;

export const UnityConfigSchema = z.object({
  // Uses UNITY_EDITOR_PATH or the matching Unity Hub editor when omitted.
  editorPath: z.string().min(1).optional(),
  // Explicit scene paths; otherwise enabled Build Settings scenes or safe
  // first-party scene candidates are used.
  scenes: z.array(z.string().min(1)).min(1).optional(),
  sceneStartIndex: z.number().int().nonnegative().default(0),
  sceneLoadWaitSeconds: z.number().nonnegative().default(2),
  includeAudio: z.boolean().default(false),
  timeoutSeconds: z.number().int().positive().default(900),
});

export const TargetConfigSchema = z.object({
  url: z.string().url(),
  // Set by `project init` when --url is omitted. Analyze then adopts the
  // local readyUrl inferred by the LLM from the project's own start script.
  autoDetectUrl: z.boolean().default(false),
  type: z.enum(['web', 'cli', 'android', 'ios', 'unity']).default('web'),
  auth: WebAuthConfigSchema.optional(),
  // Retained for compatibility. Authentication secrets are deliberately not
  // read from this generic field; manual login persists browser state instead.
  credentials: z.record(z.string()).optional(),
  android: z
    .object({
      // All fields are optional: the recorder detects conventional Android,
      // Flutter, React Native, and exported Unity Android projects.
      package: z.string().min(1).optional(),
      // Optional fully-qualified launch activity. When omitted, adb resolves
      // the package's launcher activity via `monkey`.
      activity: z.string().min(1).optional(),
      // adb serial. Omit when exactly one emulator/device is connected.
      serial: z.string().min(1).optional(),
      // Existing AVD name. The first installed AVD is used when omitted.
      avd: z.string().min(1).optional(),
      // Existing or externally-built APK, relative to the source root.
      apkPath: z.string().min(1).optional(),
      // Override for projects without a conventional Gradle/Flutter build.
      buildCommand: z.string().min(1).optional(),
      // Android SDK root containing platform-tools/, emulator/, build-tools/.
      // Falls back to ANDROID_SDK_ROOT / ANDROID_HOME / PATH.
      sdkPath: z.string().min(1).optional(),
      autoStartEmulator: z.boolean().default(true),
      autoInstall: z.boolean().default(true),
    })
    .optional(),
  unity: UnityConfigSchema.optional(),
  cli: z
    .object({
      image: z.string().min(1).default('apvg-cli-recorder:latest'),
      dockerfile: z.string().min(1).optional(),
      shell: z.string().min(1).default('/bin/bash'),
      columns: z.number().int().positive().default(100),
      rows: z.number().int().positive().default(30),
      fontSize: z.number().int().positive().default(22),
      // Commands outside the read-only --help/--version policy must be opted in
      // explicitly. Denied fragments always win over this allowlist.
      allowedCommands: z.array(z.string().min(1)).default([]),
      deniedCommandPatterns: z
        .array(z.string().min(1))
        .default(DEFAULT_CLI_DENIED_COMMAND_PATTERNS),
    })
    .default({}),
});

export const VideoConfigSchema = z.object({
  type: VideoTypeSchema.default('demo'),
  // Optional target duration. When omitted, scenario narration is not length-constrained.
  duration: z.number().int().positive().optional(),
  resolution: z.enum(['1920x1080', '1280x720', '1080x1920']).default('1920x1080'),
  fps: z.union([z.literal(30), z.literal(60)]).default(30),
  language: z.string().default('ja'),
  // Create one store-ready PNG from the final displayed frame of each scene.
  screenshots: z.boolean().default(true),
  // Optional creative direction appended to the scenario-generation prompt.
  scenarioPrompt: z.string().min(1).optional(),
  // Overlay generated subtitles during final rendering.
  subtitles: z.boolean().default(true),
  // Split each narration into short, sequential one-line subtitle cues.
  // Disable this to show the full scene narration for the scene's duration.
  singleLineSubtitles: z.boolean().default(true),
  // Extra settling time after the first web page has loaded. This warm-up
  // section is removed before narration and subtitles are rendered.
  pageReadyWaitSeconds: z.number().nonnegative().default(2),
  // Silence inserted between narration clips. Recording and subtitle timing
  // are derived from the synthesized audio using this same value.
  sceneGapSeconds: z.number().nonnegative().default(1),
});

// LLM providers. 'ollama' runs fully local via the Ollama daemon (see Taskfile `install`/`serve`).
export const LlmProviderNameSchema = z.enum(['gemini', 'openai', 'claude', 'groq', 'ollama']);
export type LlmProviderName = z.infer<typeof LlmProviderNameSchema>;

// Per-task override: analyze (understanding source code, extracting
// features) and scenario (generating the recording plan) are quite
// different tasks — some models are good at one and not the other. Falls
// back to the top-level provider/model/apiKeyEnv when a field is omitted.
export const LlmTaskOverrideSchema = z.object({
  provider: LlmProviderNameSchema.optional(),
  model: z.string().optional(),
  apiKeyEnv: z.string().optional(),
});
export type LlmTaskOverride = z.infer<typeof LlmTaskOverrideSchema>;

export const LlmConfigSchema = z.object({
  // Primary provider used for analyze/scenario generation, unless
  // overridden per-task below.
  provider: LlmProviderNameSchema.default('gemini'),
  model: z.string().default('gemini-2.5-pro'),
  apiKeyEnv: z.string().optional(),

  // Ollama-specific connection settings (used when provider === 'ollama',
  // or as the fallback target when fallbackProvider === 'ollama').
  ollamaHost: z.string().url().default('http://localhost:11434'),

  // Optional fallback provider: if the primary provider's call fails
  // (network error, missing API key, rate limit, model not pulled, etc.)
  // the fallback provider is transparently used instead. This is how
  // Gemini and a local Ollama model can be used together: e.g. provider:
  // ollama (free, offline) with fallbackProvider: gemini (higher quality,
  // needs network + API key), or the other way around.
  fallbackProvider: LlmProviderNameSchema.optional(),
  fallbackModel: z.string().optional(),
  fallbackApiKeyEnv: z.string().optional(),

  // Optional per-task overrides — e.g. a smaller/faster model is often
  // fine for `analyze` (mostly extraction/classification), while
  // `scenario generate` (structured multi-scene JSON) benefits from a
  // stronger model. Unset fields fall back to the top-level
  // provider/model/apiKeyEnv above.
  tasks: z
    .object({
      analyze: LlmTaskOverrideSchema.optional(),
      scenario: LlmTaskOverrideSchema.optional(),
    })
    .optional(),
});

export const VoicevoxConfigSchema = z.object({
  host: z.string().url().default('http://localhost:50021'),
  speakerId: z.number().int().nonnegative().default(3),
});

const AitalkStyleSchema = z
  .object({
    j: z.number().min(0).max(1).optional(),
    a: z.number().min(0).max(1).optional(),
    s: z.number().min(0).max(1).optional(),
  })
  .refine((style) => Object.values(style).reduce((sum, value) => sum + (value ?? 0), 0) <= 1, {
    message: 'AITalk style values must total 1.0 or less',
  });

const AitalkOptionsSchema = z.object({
  use_udic: z.boolean().optional(),
  // APVG's timing pipeline consumes WAV files, so other AITalk formats are not accepted here.
  ext: z.literal('wav').default('wav'),
  fs: z
    .union([
      z.literal('auto'),
      z.literal(8000),
      z.literal(11025),
      z.literal(16000),
      z.literal(22050),
      z.literal(32000),
      z.literal(44100),
      z.literal(48000),
    ])
    .optional(),
  bit: z.union([z.literal(8), z.literal(16)]).optional(),
  channels: z.union([z.literal(1), z.literal(2)]).optional(),
  mvolume: z.number().min(0.01).max(5).optional(),
  volume: z.number().min(0.01).max(2).optional(),
  speed: z.number().min(0.5).max(4).optional(),
  pitch: z.number().min(0.5).max(2).optional(),
  range: z.number().min(0).max(2).optional(),
  style: AitalkStyleSchema.optional(),
  spause: z.number().int().min(80).max(500).optional(),
  lpause: z.number().int().min(100).max(2000).optional(),
  epause: z.number().int().min(200).max(10000).optional(),
  tpause: z.number().int().min(0).max(10000).optional(),
});

export const VoiceProfileSchema = z.discriminatedUnion('type', [
  z.object({
    name: z.string().min(1).optional(),
    type: z.literal('voicevox'),
    url: z.string().url(),
    speakerId: z.number().int().nonnegative(),
  }),
  z.object({
    name: z.string().min(1).optional(),
    type: z.literal('aitalk'),
    url: z.string().url().default('https://webapi.aitalk.jp/webapi/v5/ttsget.php'),
    speakerName: z.string().min(1),
    // Any config string supports placeholders such as ${AITALK_USERNAME}.
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    // Backward-compatible alternative to username/password placeholders.
    usernameEnv: z.string().min(1).default('AITALK_USERNAME'),
    passwordEnv: z.string().min(1).default('AITALK_PASSWORD'),
    options: AitalkOptionsSchema.default({}),
  }),
]);

export const VoiceConfigSchema = z.object({
  // Profiles are assigned to scenes in order, wrapping around when necessary.
  profiles: z.array(VoiceProfileSchema).min(1),
  // Optional dotenv file. A .env next to apvg.config.yml is loaded automatically.
  envFile: z.string().min(1).optional(),
});

export const OutputConfigSchema = z.object({
  dir: z.string().default('./output'),
  workDir: z.string().default('./.apvg'),
});

export const ApvgConfigSchema = z.object({
  project: ProjectConfigSchema,
  source: SourceConfigSchema,
  // An omitted target means "detect it during analyze". The normalized
  // in-memory placeholder is never required in a user-authored config.
  target: TargetConfigSchema.default({
    url: 'http://localhost:3000',
    autoDetectUrl: true,
    type: 'web',
  }),
  video: VideoConfigSchema.default({}),
  llm: LlmConfigSchema.default({}),
  voice: VoiceConfigSchema.optional(),
  // Deprecated compatibility setting. Prefer voice.profiles.
  voicevox: VoicevoxConfigSchema.default({}),
  output: OutputConfigSchema.default({}),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type TargetConfig = z.infer<typeof TargetConfigSchema>;
export type UnityConfig = z.infer<typeof UnityConfigSchema>;
export type VideoConfig = z.infer<typeof VideoConfigSchema>;
export type LlmConfig = z.infer<typeof LlmConfigSchema>;
export type VoicevoxConfig = z.infer<typeof VoicevoxConfigSchema>;
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;
export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;
export type OutputConfig = z.infer<typeof OutputConfigSchema>;
export type ApvgConfig = z.infer<typeof ApvgConfigSchema>;
