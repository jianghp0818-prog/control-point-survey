// Photos are re-encoded on the phone: turned upright, reduced to MAX_SIDE pixels and saved as JPEG.
// Re-encoding also drops the camera's EXIF data, including its GPS position.

const MAX_SIDE = 1920;
const QUALITY = 0.85;

async function decode(file) {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // fall back to an <img> element below
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function compressPhoto(file, maxSide = MAX_SIDE, quality = QUALITY) {
  const image = await decode(file);
  const w0 = image.width, h0 = image.height;
  const ratio = Math.min(1, maxSide / Math.max(w0, h0));
  const width = Math.round(w0 * ratio), height = Math.round(h0 * ratio);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);
  if (image.close) image.close();
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Photo could not be saved"))), "image/jpeg", quality));
  return { blob, width, height };
}
