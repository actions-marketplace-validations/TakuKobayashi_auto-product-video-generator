using System.Collections;
using System.IO;
using System.Linq;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

namespace APVG.Editor.Tests
{
    public sealed class ApvgRecorderPlayModeTests
    {
        string output;
        GameObject cameraObject;

        [UnitySetUp]
        public IEnumerator SetUp()
        {
            output = Path.Combine(Application.temporaryCachePath, "apvg-recorder-playmode-test.webm");
            if (File.Exists(output)) File.Delete(output);
            cameraObject = new GameObject("APVG Test Camera");
            cameraObject.tag = "MainCamera";
            cameraObject.AddComponent<Camera>().clearFlags = CameraClearFlags.SolidColor;
            yield return null;
        }

        [UnityTearDown]
        public IEnumerator TearDown()
        {
            RecorderMethod("StopRecording").Invoke(null, null);
            if (cameraObject != null) Object.Destroy(cameraObject);
            if (File.Exists(output)) File.Delete(output);
            yield return null;
        }

        [UnityTest]
        public IEnumerator RecordsAndFinalizesANonEmptyWebM()
        {
            var editorAssembly = System.AppDomain.CurrentDomain.GetAssemblies()
                .Single(assembly => assembly.GetName().Name == "APVG.Recorder.Editor");
            var jobType = editorAssembly.GetType("APVG.Editor.RecordingJob", true);
            var job = System.Activator.CreateInstance(jobType);
            SetField(jobType, job, "output", output);
            SetField(jobType, job, "fps", 30);
            SetField(jobType, job, "width", 320);
            SetField(jobType, job, "height", 180);
            SetField(jobType, job, "includeAudio", false);

            RecorderMethod("StartRecording").Invoke(null, new[] { job });
            for (var frame = 0; frame < 10; frame++) yield return null;
            RecorderMethod("StopRecording").Invoke(null, null);

            var deadline = Time.realtimeSinceStartup + 10f;
            while (!FileReady() && Time.realtimeSinceStartup < deadline)
                yield return null;

            Assert.That(FileReady(), Is.True);
            Assert.That(new FileInfo(output).Length, Is.GreaterThan(0));
        }

        static MethodInfo RecorderMethod(string name)
        {
            var assembly = System.AppDomain.CurrentDomain.GetAssemblies()
                .Single(item => item.GetName().Name == "APVG.Recorder.Editor");
            return assembly.GetType("APVG.Editor.ApvgRecorder", true)
                .GetMethod(name, BindingFlags.Static | BindingFlags.NonPublic);
        }

        static void SetField(System.Type type, object target, string name, object value) =>
            type.GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                .SetValue(target, value);

        bool FileReady() => (bool)RecorderMethod("IsFileReady").Invoke(null, new object[] { output });
    }
}
