import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ApvgConfig, ProjectPlatform } from '@auto-product-video-generator/core';
import { readJson, writeJson } from '@auto-product-video-generator/core';

export interface ResolvedConfig {
  source?: { startCommand?: string };
  target?: {
    url?: string;
    type?: 'web' | 'cli' | 'android' | 'ios' | 'unity';
    android?: { autoStartEmulator: boolean; autoInstall: boolean };
    unity?: ApvgConfig['target']['unity'];
  };
  platform: ProjectPlatform;
  analyzedAt: string;
}

export function resolvedConfigPath(config: ApvgConfig): string {
  return join(config.output.workDir, 'resolved-config.json');
}

export async function saveResolvedConfig(
  config: ApvgConfig,
  platform: ProjectPlatform
): Promise<string> {
  const path = resolvedConfigPath(config);
  await writeJson(path, {
    source: config.source.startCommand ? { startCommand: config.source.startCommand } : undefined,
    target: {
      ...(config.target.autoDetectUrl ? {} : { url: config.target.url }),
      type: platformToTargetType(platform),
      ...(config.target.android ? { android: config.target.android } : {}),
      ...(config.target.unity ? { unity: config.target.unity } : {}),
    },
    platform,
    analyzedAt: new Date().toISOString(),
  } satisfies ResolvedConfig);
  return path;
}

export async function applyResolvedConfig(config: ApvgConfig): Promise<ApvgConfig> {
  const path = resolvedConfigPath(config);
  if (!existsSync(path)) return config;
  const resolved = await readJson<ResolvedConfig>(path);

  if (!config.source.startCommand && resolved.source?.startCommand) {
    config.source.startCommand = resolved.source.startCommand;
  }
  if (config.target.autoDetectUrl && resolved.target?.url) {
    config.target.url = resolved.target.url;
    config.target.autoDetectUrl = false;
  }
  // target.type is kept as analysis metadata only. The scenario platform selects
  // the recorder, while an explicitly configured target.type must remain authoritative.
  if (resolved.target?.android) {
    config.target.android = { ...resolved.target.android, ...config.target.android };
  }
  if (resolved.target?.unity) {
    config.target.unity = { ...resolved.target.unity, ...config.target.unity };
  }
  return config;
}

function platformToTargetType(
  platform: ProjectPlatform
): 'web' | 'cli' | 'android' | 'ios' | 'unity' {
  switch (platform) {
    case 'cli':
      return 'cli';
    case 'android':
    case 'flutter':
    case 'react-native':
      return 'android';
    case 'unity':
      return 'unity';
    case 'ios':
      return 'ios';
    case 'web':
    case 'desktop':
    case 'other':
      return 'web';
  }
}
