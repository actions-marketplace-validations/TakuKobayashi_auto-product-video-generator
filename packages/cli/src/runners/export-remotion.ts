import { copyFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import {
  ensureDir,
  loadConfig,
  logger,
  readJson,
  TimelineSchema,
  type ApvgConfig,
  type Timeline,
} from '@auto-product-video-generator/core';

interface ExportRemotionOptions {
  config?: string;
  timeline?: string;
  output?: string;
  force?: boolean;
}

const PACKAGE_JSON = {
  name: 'apvg-remotion-project',
  version: '1.0.0',
  private: true,
  type: 'module',
  scripts: {
    dev: 'remotion studio src/index.ts',
    render: 'remotion render src/index.ts ProductVideo out/video.mp4',
    typecheck: 'tsc --noEmit',
  },
  dependencies: {
    '@remotion/cli': '^4.0.0',
    react: '19.2.3',
    'react-dom': '19.2.3',
    remotion: '^4.0.0',
  },
  devDependencies: {
    '@types/react': '19.2.7',
    typescript: '5.9.3',
  },
};

export async function runExportRemotion(options: ExportRemotionOptions): Promise<void> {
  logger.header('apvg video export remotion');
  const configPath = options.config || 'apvg.config.yml';
  const config = await loadConfig(configPath);
  const timelinePath = resolve(options.timeline || join(config.output.workDir, 'timeline.json'));
  const outputDir = resolve(options.output || join(config.output.dir, 'remotion-project'));

  await exportRemotionProject(config, timelinePath, outputDir, options.force || false);
  logger.success(`Remotion project exported: ${outputDir}`);
  logger.info(`Next: cd ${outputDir}`);
  logger.info('      npm install');
  logger.info('      npm run dev');
}

export async function exportRemotionProject(
  config: ApvgConfig,
  timelinePath: string,
  outputDir: string,
  force = false
): Promise<void> {
  if (!existsSync(timelinePath)) {
    throw new Error(`Timeline not found: ${timelinePath}\nRun 'apvg video render' first.`);
  }
  if (existsSync(outputDir) && (await readdir(outputDir)).length > 0 && !force) {
    throw new Error(
      `Output directory is not empty: ${outputDir}\nUse --force to overwrite generated files.`
    );
  }

  const timeline = TimelineSchema.parse(await readJson<unknown>(timelinePath));
  const exportedTimeline = structuredClone(timeline) as Timeline;
  const workDir = resolve(config.output.workDir);
  const assets = new Map<string, string>();

  for (const track of exportedTimeline.tracks) {
    if (track.type !== 'video' && track.type !== 'audio') continue;
    const source = isAbsolute(track.src) ? resolve(track.src) : resolve(workDir, track.src);
    if (!existsSync(source)) throw new Error(`Asset not found for ${track.id}: ${source}`);

    let target = assets.get(source);
    if (!target) {
      const kind = track.type === 'video' ? 'video' : 'audio';
      const safeId = sanitizeName(track.id);
      const extension = extname(source) || extname(track.src);
      target = `assets/${kind}/${safeId}${extension}`;
      assets.set(source, target);
    }
    track.src = target;
  }

  await ensureDir(outputDir);
  for (const [source, relativeTarget] of assets) {
    const target = join(outputDir, 'public', ...relativeTarget.split('/'));
    await ensureDir(join(target, '..'));
    await copyFile(source, target);
  }

  const packageJson = { ...PACKAGE_JSON, name: `${sanitizeName(config.project.name)}-remotion` };
  await Promise.all([
    writeText(join(outputDir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n'),
    writeText(join(outputDir, 'tsconfig.json'), TS_CONFIG),
    writeText(join(outputDir, '.gitignore'), GITIGNORE),
    writeText(join(outputDir, 'README.md'), projectReadme(config.project.name)),
    writeText(join(outputDir, 'src', 'index.ts'), INDEX_SOURCE),
    writeText(join(outputDir, 'src', 'Root.tsx'), ROOT_SOURCE),
    writeText(join(outputDir, 'src', 'ProductVideo.tsx'), PRODUCT_VIDEO_SOURCE),
    writeText(join(outputDir, 'src', 'types.ts'), TYPES_SOURCE),
    writeText(
      join(outputDir, 'src', 'data', 'project.json'),
      JSON.stringify(
        { name: config.project.name, showSubtitles: config.video.subtitles },
        null,
        2
      ) + '\n'
    ),
    writeText(
      join(outputDir, 'src', 'data', 'timeline.json'),
      JSON.stringify(exportedTimeline, null, 2) + '\n'
    ),
  ]);
}

function sanitizeName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'video'
  );
}

async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content, 'utf8');
}

const TS_CONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["DOM", "ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
`;

const GITIGNORE = `node_modules/
out/
*.log
`;

const INDEX_SOURCE = `import {registerRoot} from 'remotion';
import {RemotionRoot} from './Root';

registerRoot(RemotionRoot);
`;

const ROOT_SOURCE = `import {Composition} from 'remotion';
import {ProductVideo} from './ProductVideo';
import type {Timeline} from './types';
import timeline from './data/timeline.json';
import project from './data/project.json';

export const RemotionRoot = () => {
  const [rawWidth, rawHeight] = timeline.meta.resolution.split('x').map(Number);
  const width = rawWidth ?? 1920;
  const height = rawHeight ?? 1080;
  return (
    <Composition
      id="ProductVideo"
      component={ProductVideo}
      durationInFrames={Math.max(1, Math.ceil(timeline.meta.totalDuration * timeline.meta.fps))}
      fps={timeline.meta.fps}
      width={width}
      height={height}
      defaultProps={{timeline: timeline as Timeline, showSubtitles: project.showSubtitles}}
    />
  );
};
`;

const TYPES_SOURCE = `export type Track = {
  type: 'video' | 'audio' | 'subtitle' | 'effect';
  id: string;
  src?: string;
  text?: string;
  startTime: number;
  endTime: number;
  trimStart?: number;
  speed?: number;
  volume?: number;
  style?: {
    fontSize?: number;
    color?: string;
    bgColor?: string;
    position?: 'top' | 'middle' | 'bottom';
  };
};

export type Timeline = {
  meta: {totalDuration: number; resolution: string; fps: 30 | 60};
  tracks: Track[];
};
`;

const PRODUCT_VIDEO_SOURCE = `import type {CSSProperties} from 'react';
import {AbsoluteFill, Audio, OffthreadVideo, Sequence, staticFile, useVideoConfig} from 'remotion';
import type {Timeline, Track} from './types';

type Props = {timeline: Timeline; showSubtitles: boolean};

export const ProductVideo = ({timeline, showSubtitles}: Props) => {
  const {fps} = useVideoConfig();
  const frames = (seconds: number) => Math.round(seconds * fps);
  const duration = (track: Track) => Math.max(1, frames(track.endTime - track.startTime));

  return (
    <AbsoluteFill style={{backgroundColor: 'black'}}>
      {timeline.tracks.filter((track) => track.type === 'video').map((track) => (
        <Sequence key={track.id} from={frames(track.startTime)} durationInFrames={duration(track)}>
          <OffthreadVideo
            src={staticFile(track.src!)}
            startFrom={frames(track.trimStart ?? 0)}
            playbackRate={track.speed ?? 1}
            muted
            style={{width: '100%', height: '100%', objectFit: 'cover'}}
          />
        </Sequence>
      ))}
      {timeline.tracks.filter((track) => track.type === 'audio').map((track) => (
        <Sequence key={track.id} from={frames(track.startTime)} durationInFrames={duration(track)}>
          <Audio src={staticFile(track.src!)} volume={track.volume ?? 1} />
        </Sequence>
      ))}
      {showSubtitles && timeline.tracks.filter((track) => track.type === 'subtitle').map((track) => (
        <Sequence key={track.id} from={frames(track.startTime)} durationInFrames={duration(track)}>
          <Subtitle track={track} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

const Subtitle = ({track}: {track: Track}) => {
  const position = track.style?.position ?? 'bottom';
  const align: CSSProperties['justifyContent'] = position === 'top' ? 'flex-start' : position === 'middle' ? 'center' : 'flex-end';
  return (
    <AbsoluteFill style={{justifyContent: align, alignItems: 'center', padding: '6%', pointerEvents: 'none'}}>
      <div style={{
        color: track.style?.color ?? '#fff',
        backgroundColor: track.style?.bgColor ?? 'rgba(0,0,0,0.72)',
        fontFamily: 'sans-serif',
        fontSize: track.style?.fontSize ?? 48,
        fontWeight: 700,
        lineHeight: 1.45,
        padding: '0.18em 0.5em',
        borderRadius: 8,
        textAlign: 'center',
        whiteSpace: 'pre-wrap',
      }}>{track.text}</div>
    </AbsoluteFill>
  );
};
`;

function projectReadme(name: string): string {
  return `# ${name} - Remotion project

This standalone project was exported by APVG. Its video, narration, and subtitle tracks are already connected to the \`ProductVideo\` composition.

## Start Remotion Studio

\`\`\`sh
npm install
npm run dev
\`\`\`

## Render

\`\`\`sh
npm run render
\`\`\`

- Edit the composition in \`src/ProductVideo.tsx\`.
- Edit timings and subtitle text in \`src/data/timeline.json\`.
- Toggle subtitles with \`showSubtitles\` in \`src/data/project.json\`.
- Source assets are under \`public/assets\`.
- APVG effect tracks remain in the timeline for custom editing, but are not automatically translated to Remotion effects.
`;
}
