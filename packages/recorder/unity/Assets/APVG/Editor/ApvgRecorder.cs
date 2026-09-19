// APVG Unity Editor integration. Requires com.unity.recorder.
#if UNITY_EDITOR
using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEditor.Recorder;
using UnityEditor.Recorder.Input;
using UnityEngine;

namespace APVG.Editor
{
    [Serializable] class RecordingPlan { public int timeoutSeconds; public RecordingJob[] jobs; }
    [Serializable] class RecordingJob
    {
        public string output;
        public int sceneIndex;
        public string scenePath;
        public float duration;
        public float warmup;
        public int fps;
        public int width;
        public int height;
        public bool includeAudio;
    }

    [InitializeOnLoad]
    public static class ApvgRecorder
    {
        const string ActiveKey = "APVG.Recorder.Active";
        const string PlanKey = "APVG.Recorder.Plan";
        const string IndexKey = "APVG.Recorder.Index";
        const string PhaseKey = "APVG.Recorder.Phase";
        const string DeadlineKey = "APVG.Recorder.Deadline";
        const string WaitingForPlay = "waiting-for-play";
        const string WarmingUp = "warming-up";
        const string Recording = "recording";
        const string Finalizing = "finalizing";
        const string WaitingForEdit = "waiting-for-edit";
        static RecorderController controller;
        static EditorWindow gameView;
        static Camera captureCamera;
        static RenderTexture captureTexture;

        static ApvgRecorder()
        {
            if (SessionState.GetBool(ActiveKey, false))
                EditorApplication.update += Tick;
        }

        public static void Run()
        {
            try
            {
                var planPath = Arg("-apvgPlan");
                var plan = LoadPlan(planPath);
                if (plan.jobs == null || plan.jobs.Length == 0)
                    throw new Exception("The APVG recording plan has no scenes.");
                SessionState.SetBool(ActiveKey, true);
                SessionState.SetString(PlanKey, planPath);
                SessionState.SetInt(IndexKey, 0);
                EditorApplication.update -= Tick;
                EditorApplication.update += Tick;
                Debug.Log("APVG_RECORDER_INITIALIZED");
                BeginCurrentScene(plan);
            }
            catch (Exception error) { Fail(error); }
        }

        static void Tick()
        {
            try
            {
                var plan = LoadPlan(SessionState.GetString(PlanKey, ""));
                var index = SessionState.GetInt(IndexKey, 0);
                var phase = SessionState.GetString(PhaseKey, "");
                if (phase == WaitingForPlay && EditorApplication.isPlaying)
                {
                    Application.runInBackground = true;
                    EditorApplication.isPaused = false;
                    SessionState.SetString(PhaseKey, WarmingUp);
                    SetDeadline(plan.jobs[index].warmup);
                    return;
                }
                if (phase == WaitingForPlay)
                {
                    if (DeadlineReached())
                        throw new Exception("Timed out waiting to enter Play Mode for scene " +
                            (index + 1) + "/" + plan.jobs.Length + ".");
                    return;
                }
                if (phase == WarmingUp && DeadlineReached())
                {
                    var job = plan.jobs[index];
                    Debug.Log("APVG starting Recorder: " + job.output);
                    StartRecording(job);
                    SessionState.SetString(PhaseKey, Recording);
                    SetDeadline(job.duration);
                    return;
                }
                if (phase == WarmingUp)
                {
                    PumpPlayerLoop();
                    return;
                }
                if (phase == Recording && DeadlineReached())
                {
                    StopRecording();
                    SessionState.SetString(PhaseKey, Finalizing);
                    SetDeadline(30f);
                    return;
                }
                if (phase == Recording)
                {
                    PumpPlayerLoop();
                    return;
                }
                if (phase == Finalizing)
                {
                    var job = plan.jobs[index];
                    if (IsFileReady(job.output))
                    {
                        SessionState.SetString(PhaseKey, WaitingForEdit);
                        SetDeadline(Math.Min(Math.Max(plan.timeoutSeconds, 30), 120));
                        EditorApplication.ExitPlaymode();
                    }
                    else if (DeadlineReached())
                        throw new Exception("Recorder did not finalize output: " + job.output);
                    return;
                }
                if (phase == WaitingForEdit && !EditorApplication.isPlayingOrWillChangePlaymode)
                {
                    var job = plan.jobs[index];
                    if (!File.Exists(job.output))
                        throw new Exception("Recorder output was not created: " + job.output);
                    index++;
                    SessionState.SetInt(IndexKey, index);
                    if (index >= plan.jobs.Length)
                    {
                        Debug.Log("APVG_RECORDINGS_COMPLETE");
                        ClearState();
                        EditorApplication.Exit(0);
                    }
                    else BeginCurrentScene(plan);
                    return;
                }
                if (phase == WaitingForEdit)
                {
                    if (DeadlineReached())
                    {
                        if (index == plan.jobs.Length - 1 && IsFileReady(plan.jobs[index].output))
                        {
                            Debug.LogWarning("APVG final recording is ready but Edit Mode did not return; forcing successful Editor exit.");
                            Debug.Log("APVG_RECORDINGS_COMPLETE");
                            ClearState();
                            EditorApplication.Exit(0);
                            return;
                        }
                        throw new Exception("Timed out waiting to return to Edit Mode for scene " +
                            (index + 1) + "/" + plan.jobs.Length + ".");
                    }
                }
            }
            catch (Exception error) { Fail(error); }
        }

        static void BeginCurrentScene(RecordingPlan plan)
        {
            var index = SessionState.GetInt(IndexKey, 0);
            var job = plan.jobs[index];
            var path = string.IsNullOrEmpty(job.scenePath) ? BuildScene(job.sceneIndex) : job.scenePath;
            EditorSceneManager.OpenScene(path, OpenSceneMode.Single);
            // CI runs in batch mode on an Xvfb display. The recorder captures
            // the camera's RenderTexture directly, so no Game View window is
            // required there (and creating one can block batch-mode startup).
            if (!Application.isBatchMode) EnsureGameView(job);
            SessionState.SetString(PhaseKey, WaitingForPlay);
            SetDeadline(Math.Min(Math.Max(plan.timeoutSeconds, 30), 120));
            EditorApplication.EnterPlaymode();
        }

        static void EnsureGameView(RecordingJob job)
        {
            var gameViewType = Type.GetType("UnityEditor.GameView,UnityEditor");
            if (gameViewType == null) throw new Exception("Unity Game View type was not found.");
            gameView = EditorWindow.GetWindow(gameViewType, false, "Game");
            gameView.position = new Rect(0, 0, Math.Max(640, job.width), Math.Max(360, job.height));
            gameView.Show();
            gameView.Focus();
            gameView.Repaint();
        }

        static void PumpPlayerLoop()
        {
            // A project-side exception can trigger the Editor's Error Pause after
            // Play Mode starts. Recording must keep advancing despite that setting.
            if (EditorApplication.isPaused) EditorApplication.isPaused = false;
            EditorApplication.QueuePlayerLoopUpdate();
            if (gameView != null) gameView.Repaint();
            if (captureCamera != null && captureTexture != null) captureCamera.Render();
        }

        internal static void StartRecording(RecordingJob job)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(job.output));
            captureCamera = Camera.main;
            if (captureCamera == null) captureCamera = UnityEngine.Object.FindFirstObjectByType<Camera>();
            if (captureCamera == null) throw new Exception("The scene has no Camera to record.");
            captureTexture = new RenderTexture(job.width, job.height, 24, RenderTextureFormat.ARGB32);
            captureTexture.Create();
            captureCamera.targetTexture = captureTexture;
            foreach (var canvas in UnityEngine.Object.FindObjectsByType<Canvas>(FindObjectsSortMode.None))
            {
                if (canvas.renderMode != RenderMode.ScreenSpaceOverlay) continue;
                canvas.renderMode = RenderMode.ScreenSpaceCamera;
                canvas.worldCamera = captureCamera;
                canvas.planeDistance = Math.Max(captureCamera.nearClipPlane + 0.1f, 1f);
            }
            var movie = ScriptableObject.CreateInstance<MovieRecorderSettings>();
            movie.name = "APVG Movie Recorder";
            movie.Enabled = true;
            // WebM is the portable intermediate shared by local and Linux CI runs.
            // APVG converts it to its standard H.264/AAC MP4 after Unity exits.
            movie.OutputFormat = MovieRecorderSettings.VideoRecorderOutputFormat.WebM;
            movie.OutputFile = Path.ChangeExtension(job.output, null);
            movie.ImageInputSettings = new RenderTextureInputSettings
            {
                RenderTexture = captureTexture
            };
            movie.AudioInputSettings.PreserveAudio = job.includeAudio;
            var settings = ScriptableObject.CreateInstance<RecorderControllerSettings>();
            settings.AddRecorderSettings(movie);
            settings.SetRecordModeToManual();
            settings.FrameRate = job.fps;
            settings.FrameRatePlayback = FrameRatePlayback.Constant;
            settings.CapFrameRate = true;
            settings.ExitPlayMode = false;
            controller = new RecorderController(settings);
            controller.PrepareRecording();
            if (!controller.StartRecording()) throw new Exception("Unity Recorder refused to start.");
        }

        internal static void StopRecording()
        {
            if (controller != null && controller.IsRecording()) controller.StopRecording();
            if (captureCamera != null) captureCamera.targetTexture = null;
        }

        static RecordingPlan LoadPlan(string path) =>
            JsonUtility.FromJson<RecordingPlan>(File.ReadAllText(path));

        static void SetDeadline(float seconds) =>
            SessionState.SetString(DeadlineKey, DateTime.UtcNow.AddSeconds(seconds).Ticks.ToString());

        static bool DeadlineReached()
        {
            long ticks;
            return long.TryParse(SessionState.GetString(DeadlineKey, "0"), out ticks) &&
                DateTime.UtcNow.Ticks >= ticks;
        }

        internal static bool IsFileReady(string path)
        {
            if (!File.Exists(path) || new FileInfo(path).Length == 0) return false;
            try
            {
                using (File.Open(path, FileMode.Open, FileAccess.Read, FileShare.None)) { }
                return true;
            }
            catch (IOException) { return false; }
        }

        static string BuildScene(int enabledIndex)
        {
            var scenes = EditorBuildSettings.scenes.Where(scene => scene.enabled).ToArray();
            if (enabledIndex < 0 || enabledIndex >= scenes.Length)
                throw new Exception("Build Settings scene index " + enabledIndex +
                    " is unavailable; enabled count is " + scenes.Length + ".");
            return scenes[enabledIndex].path;
        }

        static string Arg(string name)
        {
            var args = Environment.GetCommandLineArgs();
            var index = Array.IndexOf(args, name);
            if (index < 0 || index + 1 >= args.Length) throw new Exception("Missing argument: " + name);
            return args[index + 1];
        }

        static void Fail(Exception error)
        {
            Debug.LogException(error);
            ClearState();
            EditorApplication.Exit(1);
        }

        static void ClearState()
        {
            EditorApplication.update -= Tick;
            SessionState.EraseBool(ActiveKey);
            SessionState.EraseString(PlanKey);
            SessionState.EraseInt(IndexKey);
            SessionState.EraseString(PhaseKey);
            SessionState.EraseString(DeadlineKey);
        }
    }
}
#endif
