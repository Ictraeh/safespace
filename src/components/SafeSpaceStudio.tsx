"use client";

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { motion, useMotionValue } from "framer-motion";
import Cropper, { type Area, type Point } from "react-easy-crop";
import { type ChangeEvent, useEffect, useMemo, useState } from "react";

type PlatformKey = "tiktok" | "reels" | "shorts";
type EditorTab = "video" | "photo";
type PhotoRatioKey = "square" | "portrait" | "twitter" | "pinterest";
type OverlayPreset = {
  label: string;
  top: number;
  bottom: number;
  right: number;
  left: number;
};

const PLATFORM_PRESETS: Record<PlatformKey, OverlayPreset> = {
  tiktok: { label: "TikTok", top: 0.08, bottom: 0.24, right: 0.2, left: 0.04 },
  reels: { label: "IG Reels", top: 0.06, bottom: 0.22, right: 0.18, left: 0.05 },
  shorts: { label: "YT Shorts", top: 0.07, bottom: 0.2, right: 0.2, left: 0.05 },
};

const PHOTO_RATIOS: Record<PhotoRatioKey, { label: string; aspect: number }> = {
  square: { label: "IG Square 1:1", aspect: 1 },
  portrait: { label: "IG Portrait 4:5", aspect: 4 / 5 },
  twitter: { label: "Twitter 16:9", aspect: 16 / 9 },
  pinterest: { label: "Pinterest 2:3", aspect: 2 / 3 },
};

const PREVIEW_WIDTH = 1080;
const PREVIEW_HEIGHT = 1920;

let ffmpeg: FFmpeg | null = null;
let ffmpegLoaded = false;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
const createImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image load failed"));
    image.src = url;
  });

export function SafeSpaceStudio() {
  const [tab, setTab] = useState<EditorTab>("video");

  // video editor state
  const [platform, setPlatform] = useState<PlatformKey>("tiktok");
  const [videoURL, setVideoURL] = useState<string | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [sourceSize, setSourceSize] = useState({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT });
  const [scale, setScale] = useState(1);
  const [isRendering, setIsRendering] = useState(false);
  const [showLongRenderTooltip, setShowLongRenderTooltip] = useState(false);
  const panX = useMotionValue(0);
  const panY = useMotionValue(0);

  // photo editor state
  const [photoURL, setPhotoURL] = useState<string | null>(null);
  const [photoFileType, setPhotoFileType] = useState<"image/jpeg" | "image/png">("image/png");
  const [photoCrop, setPhotoCrop] = useState<Point>({ x: 0, y: 0 });
  const [photoZoom, setPhotoZoom] = useState(1);
  const [photoRatio, setPhotoRatio] = useState<PhotoRatioKey>("square");
  const [photoCropPixels, setPhotoCropPixels] = useState<Area | null>(null);
  const [photoWidth, setPhotoWidth] = useState(0);
  const [isPhotoProcessing, setIsPhotoProcessing] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const overlay = PLATFORM_PRESETS[platform];
  const safeRect = useMemo(
    () => ({
      x: overlay.left * PREVIEW_WIDTH,
      y: overlay.top * PREVIEW_HEIGHT,
      width: PREVIEW_WIDTH * (1 - overlay.left - overlay.right),
      height: PREVIEW_HEIGHT * (1 - overlay.top - overlay.bottom),
    }),
    [overlay],
  );

  useEffect(() => {
    if (!toastMessage) {
      return;
    }
    const timeout = setTimeout(() => setToastMessage(null), 3200);
    return () => clearTimeout(timeout);
  }, [toastMessage]);

  useEffect(() => {
    if (!videoURL) return;
    return () => URL.revokeObjectURL(videoURL);
  }, [videoURL]);

  useEffect(() => {
    if (!photoURL) return;
    return () => URL.revokeObjectURL(photoURL);
  }, [photoURL]);

  const showToast = (message: string) => setToastMessage(message);

  const isSupportedVideo = (file: File) => {
    const mime = file.type.toLowerCase();
    const ext = file.name.toLowerCase();
    return (
      mime === "video/mp4" ||
      mime === "video/quicktime" ||
      ext.endsWith(".mp4") ||
      ext.endsWith(".mov")
    );
  };

  const readMetadata = (file: File): Promise<{ duration: number; width: number; height: number }> =>
    new Promise((resolve, reject) => {
      const tempURL = URL.createObjectURL(file);
      const probe = document.createElement("video");
      probe.preload = "metadata";
      probe.src = tempURL;
      probe.onloadedmetadata = () => {
        resolve({
          duration: probe.duration || 0,
          width: probe.videoWidth || PREVIEW_WIDTH,
          height: probe.videoHeight || PREVIEW_HEIGHT,
        });
        URL.revokeObjectURL(tempURL);
      };
      probe.onerror = () => {
        URL.revokeObjectURL(tempURL);
        reject(new Error("Unable to read video metadata."));
      };
    });

  const onVideoFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!isSupportedVideo(file)) {
      showToast("Please upload an MP4 or MOV file.");
      event.target.value = "";
      return;
    }

    try {
      const meta = await readMetadata(file);
      if (meta.duration > 60) {
        showToast("Keep it snappy! SafeSpace is for shorts under 60 seconds.");
        event.target.value = "";
        return;
      }

      if (videoURL) URL.revokeObjectURL(videoURL);
      const newURL = URL.createObjectURL(file);
      setVideoURL(newURL);
      setVideoFile(file);
      setVideoDuration(meta.duration);
      setSourceSize({ width: meta.width, height: meta.height });
      setScale(1);
      panX.set(0);
      panY.set(0);
    } catch {
      showToast("Could not load that video. Try another file.");
    }
  };

  const ensureFFmpeg = async (): Promise<FFmpeg> => {
    if (!ffmpeg) {
      ffmpeg = new FFmpeg();
    }
    if (ffmpegLoaded) return ffmpeg;
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
    });
    ffmpegLoaded = true;
    return ffmpeg;
  };

  const buildCropValues = () => {
    const inputW = sourceSize.width;
    const inputH = sourceSize.height;
    const baseScale = Math.max(PREVIEW_WIDTH / inputW, PREVIEW_HEIGHT / inputH);
    const appliedScale = baseScale * scale;
    const displayedW = inputW * appliedScale;
    const displayedH = inputH * appliedScale;
    const left = (PREVIEW_WIDTH - displayedW) / 2 + panX.get();
    const top = (PREVIEW_HEIGHT - displayedH) / 2 + panY.get();

    const x1 = clamp((safeRect.x - left) / appliedScale, 0, inputW - 2);
    const y1 = clamp((safeRect.y - top) / appliedScale, 0, inputH - 2);
    const x2 = clamp((safeRect.x + safeRect.width - left) / appliedScale, x1 + 2, inputW);
    const y2 = clamp((safeRect.y + safeRect.height - top) / appliedScale, y1 + 2, inputH);

    const cropW = even(x2 - x1);
    const cropH = even(y2 - y1);
    const cropX = even(clamp(x1, 0, inputW - cropW));
    const cropY = even(clamp(y1, 0, inputH - cropH));
    const outputW = even(inputW);
    const outputH = even(inputH);

    return { cropW, cropH, cropX, cropY, outputW, outputH };
  };

  const onVideoRender = async () => {
    if (!videoFile) {
      showToast("Upload a video first.");
      return;
    }

    setIsRendering(true);
    setShowLongRenderTooltip(false);
    const tooltipTimer = setTimeout(() => {
      setShowLongRenderTooltip(true);
    }, 5000);

    try {
      const worker = await ensureFFmpeg();
      const inputName = `input-${Date.now()}.mp4`;
      const outputName = `safespace-${platform}-${Date.now()}.mp4`;

      await worker.writeFile(inputName, await fetchFile(videoFile));
      const crop = buildCropValues();
      await worker.exec([
        "-i",
        inputName,
        "-vf",
        `crop=${crop.cropW}:${crop.cropH}:${crop.cropX}:${crop.cropY},scale=${crop.outputW}:${crop.outputH}:flags=lanczos`,
        "-movflags",
        "+faststart",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-an",
        outputName,
      ]);

      const data = (await worker.readFile(outputName)) as Uint8Array;
      const safeBuffer = new ArrayBuffer(data.byteLength);
      new Uint8Array(safeBuffer).set(data);
      const blob = new Blob([safeBuffer], { type: "video/mp4" });
      const downloadURL = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = downloadURL;
      anchor.download = `safespace-${platform}.mp4`;
      anchor.click();
      URL.revokeObjectURL(downloadURL);
      showToast("Rendered successfully. Download started.");
    } catch {
      showToast("Rendering hit a snag. Please try again.");
    } finally {
      clearTimeout(tooltipTimer);
      setShowLongRenderTooltip(false);
      setIsRendering(false);
    }
  };

  const onPhotoFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const lowerName = file.name.toLowerCase();
    const valid =
      file.type === "image/jpeg" ||
      file.type === "image/png" ||
      lowerName.endsWith(".jpg") ||
      lowerName.endsWith(".jpeg") ||
      lowerName.endsWith(".png");

    if (!valid) {
      showToast("Please upload a JPG or PNG image.");
      event.target.value = "";
      return;
    }

    const src = URL.createObjectURL(file);
    try {
      const image = await createImage(src);
      if (photoURL) URL.revokeObjectURL(photoURL);
      setPhotoURL(src);
      setPhotoFileType(file.type === "image/jpeg" ? "image/jpeg" : "image/png");
      setPhotoWidth(image.naturalWidth);
      setPhotoCrop({ x: 0, y: 0 });
      setPhotoZoom(1);
    } catch {
      URL.revokeObjectURL(src);
      showToast("Could not load this image. Try another file.");
    }
  };

  const onPhotoDownload = async () => {
    if (!photoURL || !photoCropPixels) {
      showToast("Upload and frame your photo first.");
      return;
    }

    setIsPhotoProcessing(true);
    try {
      const image = await createImage(photoURL);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(photoCropPixels.width));
      canvas.height = Math.max(1, Math.round(photoCropPixels.height));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas not supported");

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(
        image,
        photoCropPixels.x,
        photoCropPixels.y,
        photoCropPixels.width,
        photoCropPixels.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );

      await new Promise<void>((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error("Image export failed"));
              return;
            }
            const downloadURL = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = downloadURL;
            anchor.download = `safespace-${photoRatio}.${photoFileType === "image/png" ? "png" : "jpg"}`;
            anchor.click();
            URL.revokeObjectURL(downloadURL);
            showToast("Cropped image downloaded.");
            resolve();
          },
          photoFileType,
          0.95,
        );
      });
    } catch {
      showToast("Image export failed. Please try again.");
    } finally {
      setIsPhotoProcessing(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col items-center px-4 py-10 md:px-8">
      <motion.header
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55 }}
        className="mb-8 w-full text-center"
      >
        <h1 className="font-heading text-4xl tracking-tight text-white md:text-6xl">SafeSpace</h1>
      </motion.header>

      <section className="mb-6 w-full max-w-xl">
        <div className="glass-card grid grid-cols-2 rounded-full p-1">
          <TabToggleButton
            label="Video Safe Zones"
            active={tab === "video"}
            onClick={() => setTab("video")}
          />
          <TabToggleButton
            label="Social Photo Crop"
            active={tab === "photo"}
            onClick={() => setTab("photo")}
          />
        </div>
      </section>

      <section className="glass-card w-full max-w-xl rounded-[28px] p-5 md:p-7">
        {tab === "video" ? (
          <>
            <div className="mb-4 flex items-center justify-between">
              <p className="font-body text-xs uppercase tracking-[0.2em] text-neutral-400">
                Don&apos;t let TikTok UI ruin your punchline.
              </p>
              <label className="focus-ring cursor-pointer rounded-full border border-white/20 bg-white/10 px-4 py-2 text-xs font-semibold text-white transition hover:border-white/40">
                Upload MP4/MOV
                <input
                  className="hidden"
                  type="file"
                  accept="video/mp4,video/quicktime,.mp4,.mov"
                  onChange={onVideoFileChange}
                />
              </label>
            </div>

            <div className="relative mx-auto aspect-[9/16] w-full overflow-hidden rounded-2xl border border-white/10 bg-black">
              {videoURL ? (
                <>
                  <motion.div
                    drag
                    dragMomentum={false}
                    className="absolute inset-0 flex items-center justify-center"
                    style={{ x: panX, y: panY, scale }}
                  >
                    <video
                      className="h-full w-full object-cover"
                      src={videoURL}
                      autoPlay
                      muted
                      loop
                      playsInline
                    />
                  </motion.div>
                  <OverlayMask overlay={overlay} />
                </>
              ) : (
                <label className="focus-ring flex h-full cursor-pointer items-center justify-center px-8 text-center">
                  <span className="font-body text-sm text-neutral-400">
                    Don&apos;t let TikTok UI ruin your punchline.
                  </span>
                  <input
                    className="hidden"
                    type="file"
                    accept="video/mp4,video/quicktime,.mp4,.mov"
                    onChange={onVideoFileChange}
                  />
                </label>
              )}
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              {(Object.keys(PLATFORM_PRESETS) as PlatformKey[]).map((key) => {
                const active = key === platform;
                return (
                  <button
                    key={key}
                    onClick={() => setPlatform(key)}
                    className={`focus-ring rounded-full px-4 py-2 text-sm font-semibold transition ${
                      active
                        ? "bg-[#FF385C] text-white"
                        : "border border-white/15 bg-white/5 text-white hover:border-white/35"
                    }`}
                  >
                    {PLATFORM_PRESETS[key].label}
                  </button>
                );
              })}
            </div>

            <div className="mt-5">
              <div className="mb-2 flex items-center justify-between text-xs text-neutral-400">
                <span>Scale</span>
                <span>{scale.toFixed(2)}x</span>
              </div>
              <input
                type="range"
                min={1}
                max={2}
                step={0.01}
                value={scale}
                onChange={(event) => setScale(Number(event.target.value))}
                className="focus-ring h-2 w-full cursor-pointer appearance-none rounded-full bg-white/15 accent-[#FF385C]"
              />
              <p className="mt-2 text-xs text-neutral-500">
                Drag the video to pan. Keep action inside the clear center zone.
              </p>
            </div>

            <div className="mt-6 flex items-center justify-between">
              <p className="text-xs text-neutral-500">
                {videoDuration > 0 ? `${videoDuration.toFixed(1)}s` : "No video loaded"}
              </p>
              <button
                onClick={onVideoRender}
                disabled={isRendering}
                className="focus-ring relative inline-flex items-center gap-2 rounded-full bg-[#FF385C] px-5 py-2.5 text-sm font-semibold text-white transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isRendering ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/70 border-t-transparent" />
                    <span>Rendering</span>
                    {showLongRenderTooltip && (
                      <span className="absolute -top-11 right-0 rounded-lg border border-white/15 bg-black px-3 py-1 text-[11px] text-white">
                        Reticulating splines... (and encoding your video).
                      </span>
                    )}
                  </>
                ) : (
                  "Render & Download"
                )}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mb-4 flex items-center justify-between">
              <p className="font-body text-xs uppercase tracking-[0.2em] text-neutral-400">
                Perfectly frame your grid.
              </p>
              <label className="focus-ring cursor-pointer rounded-full border border-white/20 bg-white/10 px-4 py-2 text-xs font-semibold text-white transition hover:border-white/40">
                Upload JPG/PNG
                <input
                  className="hidden"
                  type="file"
                  accept="image/jpeg,image/png,.jpg,.jpeg,.png"
                  onChange={onPhotoFileChange}
                />
              </label>
            </div>

            <div className="relative mx-auto h-[420px] w-full overflow-hidden rounded-2xl border border-white/10 bg-black">
              {photoURL ? (
                <Cropper
                  image={photoURL}
                  crop={photoCrop}
                  zoom={photoZoom}
                  aspect={PHOTO_RATIOS[photoRatio].aspect}
                  onCropChange={setPhotoCrop}
                  onZoomChange={setPhotoZoom}
                  onCropComplete={(_, croppedAreaPixels) => setPhotoCropPixels(croppedAreaPixels)}
                  showGrid
                  objectFit="horizontal-cover"
                />
              ) : (
                <label className="focus-ring flex h-full cursor-pointer items-center justify-center px-8 text-center">
                  <span className="font-body text-sm text-neutral-400">Perfectly frame your grid.</span>
                  <input
                    className="hidden"
                    type="file"
                    accept="image/jpeg,image/png,.jpg,.jpeg,.png"
                    onChange={onPhotoFileChange}
                  />
                </label>
              )}
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              {(Object.keys(PHOTO_RATIOS) as PhotoRatioKey[]).map((key) => {
                const active = photoRatio === key;
                return (
                  <button
                    key={key}
                    onClick={() => setPhotoRatio(key)}
                    className={`focus-ring rounded-full px-4 py-2 text-sm font-semibold transition ${
                      active
                        ? "bg-[#FF385C] text-white"
                        : "border border-white/15 bg-white/5 text-white hover:border-white/35"
                    }`}
                  >
                    {PHOTO_RATIOS[key].label}
                  </button>
                );
              })}
            </div>

            <div className="mt-5">
              <div className="mb-2 flex items-center justify-between text-xs text-neutral-400">
                <span>Zoom</span>
                <span>{photoZoom.toFixed(2)}x</span>
              </div>
              <input
                type="range"
                min={1}
                max={3}
                step={0.01}
                value={photoZoom}
                onChange={(event) => setPhotoZoom(Number(event.target.value))}
                className="focus-ring h-2 w-full cursor-pointer appearance-none rounded-full bg-white/15 accent-[#FF385C]"
              />
            </div>

            <div className="mt-6 flex items-center justify-between">
              <div className="text-xs text-neutral-500">
                {photoWidth > 0 ? `${photoWidth}px wide input` : "No image loaded"}
              </div>
              <div className="relative">
                <button
                  onClick={onPhotoDownload}
                  disabled={isPhotoProcessing}
                  className="focus-ring inline-flex items-center gap-2 rounded-full bg-[#FF385C] px-5 py-2.5 text-sm font-semibold text-white transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isPhotoProcessing ? "Cropping..." : "Crop & Download"}
                </button>
                {photoWidth > 0 && photoWidth < 1080 && (
                  <span className="absolute -top-12 right-0 w-60 rounded-lg border border-yellow-400/40 bg-yellow-300/15 px-3 py-1 text-[11px] text-yellow-200">
                    Warning: Image might look pixelated on high-res screens.
                  </span>
                )}
              </div>
            </div>
          </>
        )}
      </section>

      {toastMessage && (
        <div className="fixed bottom-6 right-6 rounded-xl border border-white/10 bg-[#121214] px-4 py-3 text-sm text-white shadow-2xl">
          {toastMessage}
        </div>
      )}
    </main>
  );
}

function TabToggleButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`focus-ring relative z-10 overflow-hidden rounded-full px-4 py-2 text-sm font-semibold transition ${
        active ? "text-white" : "text-neutral-300"
      }`}
    >
      {active && (
        <motion.span
          layoutId="active-tab"
          transition={{ type: "spring", bounce: 0.15, duration: 0.4 }}
          className="absolute inset-0 -z-10 rounded-full bg-[#FF385C]"
        />
      )}
      <span className="relative z-10">{label}</span>
    </button>
  );
}

function OverlayMask({ overlay }: { overlay: OverlayPreset }) {
  return (
    <div className="pointer-events-none absolute inset-0">
      <div
        className="absolute left-0 right-0 top-0 bg-black/45"
        style={{ height: `${overlay.top * 100}%` }}
      />
      <div
        className="absolute bottom-0 left-0 right-0 bg-black/55"
        style={{ height: `${overlay.bottom * 100}%` }}
      />
      <div
        className="absolute bottom-0 top-0 right-0 bg-black/45"
        style={{ width: `${overlay.right * 100}%` }}
      />
      <div
        className="absolute bottom-0 top-0 left-0 bg-black/25"
        style={{ width: `${overlay.left * 100}%` }}
      />
      <div
        className="absolute border border-dashed border-white/70"
        style={{
          left: `${overlay.left * 100}%`,
          top: `${overlay.top * 100}%`,
          right: `${overlay.right * 100}%`,
          bottom: `${overlay.bottom * 100}%`,
        }}
      />
    </div>
  );
}
