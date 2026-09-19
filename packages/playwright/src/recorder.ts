import { chromium, Page, BrowserContext } from 'playwright';
import { spawn } from 'node:child_process';
import { rename, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  Scene,
  Action,
  Scenario,
  VideoConfig,
  logger,
  resolveFfmpegPath,
} from '@auto-product-video-generator/core';

export interface RecordOptions {
  headed: boolean;
  slowMo: number;
  outputDir: string;
  screenshotDir: string;
  dryRun: boolean;
  /** Playwright authentication state captured by `apvg auth login`. */
  storageStatePath?: string;
}

export class SceneRecorder {
  async recordAll(
    scenario: Scenario,
    config: VideoConfig,
    options: RecordOptions
  ): Promise<string[]> {
    const outputPaths: string[] = [];

    for (const scene of scenario.scenes) {
      const outputPath = await this.recordScene(scene, config, options);
      outputPaths.push(outputPath);
    }

    return outputPaths;
  }

  async recordScene(
    scene: Scene,
    config: VideoConfig,
    options: RecordOptions,
    targetDurationSeconds?: number,
    actionDurationSeconds = targetDurationSeconds
  ): Promise<string> {
    const [width, height] = config.resolution.split('x').map(Number);
    const outputPath = join(options.outputDir, `scene-${scene.id}.mp4`);

    logger.step('record', `Scene: ${scene.id} → ${outputPath}`);

    if (options.dryRun) {
      logger.dryRun(`Would record scene '${scene.id}' with ${scene.actions.length} actions`);
      for (const action of scene.actions) {
        logger.dryRun(`  action: ${action.type}${this.describeAction(action)}`);
      }
      return outputPath;
    }

    await Promise.all([
      !existsSync(options.outputDir)
        ? mkdir(options.outputDir, { recursive: true })
        : Promise.resolve(),
      !existsSync(options.screenshotDir)
        ? mkdir(options.screenshotDir, { recursive: true })
        : Promise.resolve(),
    ]);

    const browser = await chromium.launch({
      headless: !options.headed,
      slowMo: options.slowMo,
    });

    const context = await browser.newContext({
      viewport: { width, height },
      storageState: options.storageStatePath,
      recordVideo: {
        dir: options.outputDir,
        size: { width, height },
      },
    });

    const recordingStartedAt = Date.now();
    const page = await context.newPage();
    let recordingError: unknown;
    let warmupSeconds = 0;

    try {
      let actions = scene.actions;
      const firstAction = actions[0];
      if (firstAction?.type === 'goto') {
        await this.executeAction(page, firstAction, options.screenshotDir);
        await this.waitForPageReady(page, config.pageReadyWaitSeconds);
        warmupSeconds = (Date.now() - recordingStartedAt) / 1000;
        actions = actions.slice(1);
        logger.dim(
          `  Page ready; trimming ${warmupSeconds.toFixed(1)}s warm-up from the recording`
        );
      }

      // Narration and subtitle timing starts here, after the page is ready.
      const startedAt = Date.now();
      await this.executeActions(
        page,
        actions,
        options.screenshotDir,
        actionDurationSeconds,
        startedAt
      );
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      const holdSeconds = Math.max(0, (targetDurationSeconds ?? 0.5) - elapsedSeconds);
      if (holdSeconds > 0) {
        logger.dim(`  Holding final frame for ${holdSeconds.toFixed(1)}s`);
        await page.waitForTimeout(holdSeconds * 1000);
      } else if (targetDurationSeconds && elapsedSeconds > targetDurationSeconds) {
        logger.warn(
          `Scene '${scene.id}' actions took ${elapsedSeconds.toFixed(1)}s, ` +
            `longer than its ${targetDurationSeconds.toFixed(1)}s narration slot.`
        );
      }
    } catch (err) {
      recordingError = err;
      logger.error(`Scene '${scene.id}' recording failed: ${(err as Error).message}`);
    } finally {
      const videoPath = await page.video()?.path();
      await context.close();
      await browser.close();

      // Playwright writes video after context.close()
      if (videoPath && existsSync(videoPath)) {
        if (warmupSeconds > 0) {
          await this.trimWarmup(videoPath, outputPath, warmupSeconds, targetDurationSeconds);
          await unlink(videoPath).catch(() => undefined);
        } else {
          await rename(videoPath, outputPath);
        }
        logger.success(`Saved: ${outputPath}`);
      } else {
        logger.warn(`Video file not found for scene '${scene.id}'`);
      }
    }

    if (recordingError) {
      throw new Error(`Failed to record scene '${scene.id}'. Partial recording was saved.`, {
        cause: recordingError,
      });
    }

    return outputPath;
  }

  private async waitForPageReady(page: Page, extraWaitSeconds: number): Promise<void> {
    await page.waitForLoadState('networkidle');
    // Use a string expression because this package intentionally compiles
    // without DOM globals; the expression itself runs inside the page.
    await page.evaluate(`async () => {
      await document.fonts?.ready;
      await Promise.all(Array.from(document.images)
        .filter((image) => !image.complete)
        .map((image) => new Promise((resolve) => {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', resolve, { once: true });
        })));
    }`);
    if (extraWaitSeconds > 0) {
      logger.dim(`  Waiting ${extraWaitSeconds.toFixed(1)}s for the page to settle`);
      await page.waitForTimeout(extraWaitSeconds * 1000);
    }
  }

  private trimWarmup(
    inputPath: string,
    outputPath: string,
    warmupSeconds: number,
    targetDurationSeconds?: number
  ): Promise<void> {
    const args = [
      '-y',
      '-ss',
      warmupSeconds.toFixed(3),
      '-i',
      inputPath,
      ...(targetDurationSeconds ? ['-t', targetDurationSeconds.toFixed(3)] : []),
      '-an',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      outputPath,
    ];
    return new Promise((resolvePromise, reject) => {
      const child = spawn(resolveFfmpegPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolvePromise()
          : reject(new Error(`Could not trim browser warm-up (${code}): ${stderr.trim()}`))
      );
    });
  }

  private async executeActions(
    page: Page,
    actions: Action[],
    screenshotDir: string,
    targetDurationSeconds?: number,
    startedAt = Date.now()
  ): Promise<void> {
    for (let index = 0; index < actions.length; index++) {
      const action = actions[index];
      await this.executeAction(page, action, screenshotDir);
      // Spread quick interactions across the narration instead of executing
      // every click immediately and showing only a long frozen final frame.
      if (targetDurationSeconds && actions.length > 0) {
        const milestoneMs = (targetDurationSeconds * 1000 * (index + 1)) / actions.length;
        const elapsedMs = Date.now() - startedAt;
        await page.waitForTimeout(Math.max(0, milestoneMs - elapsedMs));
      } else {
        await page.waitForTimeout(100);
      }
    }
  }

  private async executeAction(page: Page, action: Action, screenshotDir: string): Promise<void> {
    switch (action.type) {
      case 'goto':
        {
          const response = await page.goto(action.url, { waitUntil: 'networkidle' });
          if (!response) throw new Error(`Navigation to ${action.url} returned no response`);
          if (!response.ok()) {
            throw new Error(`Navigation to ${action.url} returned HTTP ${response.status()}`);
          }
        }
        break;

      case 'click': {
        const loc = this.resolveLocator(page, action);
        await loc.click();
        break;
      }

      case 'type': {
        const loc = this.resolveLocator(page, action);
        await loc.fill('');
        await loc.pressSequentially(action.value, { delay: action.delay ?? 40 });
        break;
      }

      case 'wait_visible': {
        const loc = this.resolveLocator(page, action);
        await loc.waitFor({ state: 'visible', timeout: action.timeout ?? 10000 });
        break;
      }

      case 'wait':
        await page.waitForTimeout(action.ms);
        break;

      case 'scroll':
        await page.mouse.wheel(0, action.direction === 'down' ? action.amount : -action.amount);
        break;

      case 'hover': {
        const loc = this.resolveLocator(page, action);
        await loc.hover();
        break;
      }

      case 'screenshot': {
        const p = join(screenshotDir, `${action.name}.png`);
        await page.screenshot({ path: p, fullPage: false });
        logger.dim(`  Screenshot saved: ${p}`);
        break;
      }

      case 'launch_app':
      case 'tap':
      case 'input_text':
      case 'swipe':
      case 'back':
        throw new Error(`Action '${action.type}' is only valid for a device recorder.`);

      default:
        logger.warn(`Unknown action type: ${(action as Action).type}`);
    }
  }

  private resolveLocator(
    page: Page,
    action: { text?: string; selector?: string; role?: string; label?: string }
  ) {
    if (action.role && action.label) {
      return page.getByRole(action.role as Parameters<Page['getByRole']>[0], {
        name: action.label,
      });
    }
    if (action.label) {
      return page.getByLabel(action.label);
    }
    if (action.text) {
      return page.getByText(action.text, { exact: false });
    }
    if (action.selector) {
      return page.locator(action.selector);
    }
    throw new Error(
      `Action must specify at least one of: text, label, role+label, or selector.\nAction: ${JSON.stringify(action)}`
    );
  }

  private describeAction(action: Action): string {
    switch (action.type) {
      case 'goto':
        return ` → ${action.url}`;
      case 'click':
        return ` "${action.text || action.label || action.selector}"`;
      case 'type':
        return ` "${action.value.slice(0, 20)}${action.value.length > 20 ? '...' : ''}"`;
      case 'wait':
        return ` ${action.ms}ms`;
      case 'wait_visible':
        return ` "${action.text || action.selector}"`;
      case 'scroll':
        return ` ${action.direction} ${action.amount}px`;
      case 'hover':
        return ` "${action.text || action.label || action.selector}"`;
      case 'screenshot':
        return ` "${action.name}"`;
      case 'launch_app':
        return '';
      case 'tap':
        return ` "${action.text || action.contentDescription || `${action.x},${action.y}`}"`;
      case 'input_text':
        return ` "${action.value.slice(0, 20)}"`;
      case 'swipe':
        return ` ${action.fromX},${action.fromY} → ${action.toX},${action.toY}`;
      case 'back':
        return '';
      default:
        return '';
    }
  }
}
