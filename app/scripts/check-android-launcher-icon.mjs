import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const appRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(appRoot, "..");
const referenceIcon = path.join(repoRoot, "assets/ripple-launcher-icon-2048.png");
const adaptiveVisibleFraction = 72 / 108;
const maxRatioDrift = 0.045;

const densityDirs = ["mipmap-mdpi", "mipmap-hdpi", "mipmap-xhdpi", "mipmap-xxhdpi", "mipmap-xxxhdpi"];
const resourceRoots = [
  path.join(appRoot, "src-tauri/icons/android"),
  path.join(appRoot, "src-tauri/gen/android/app/src/main/res"),
];

function parsePng(filePath) {
  const buffer = fs.readFileSync(filePath);
  const signature = buffer.subarray(0, 8).toString("hex");

  if (signature !== "89504e470d0a1a0a") {
    throw new Error(`${filePath} is not a PNG file`);
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  const idatChunks = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    offset += 4;
    const type = buffer.subarray(offset, offset + 4).toString("ascii");
    offset += 4;
    const data = buffer.subarray(offset, offset + length);
    offset += length + 4;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];

      if (bitDepth !== 8 || colorType !== 6) {
        throw new Error(`${filePath} must be an 8-bit RGBA PNG, got bit depth ${bitDepth}, color type ${colorType}`);
      }
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const pixels = Buffer.alloc(height * stride);
  let rawOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset];
    rawOffset += 1;
    const row = raw.subarray(rawOffset, rawOffset + stride);
    rawOffset += stride;
    const output = pixels.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? output[x - bytesPerPixel] : 0;
      const up = previous ? previous[x] : 0;
      const upLeft = previous && x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;

      if (filter === 0) {
        output[x] = row[x];
      } else if (filter === 1) {
        output[x] = (row[x] + left) & 255;
      } else if (filter === 2) {
        output[x] = (row[x] + up) & 255;
      } else if (filter === 3) {
        output[x] = (row[x] + Math.floor((left + up) / 2)) & 255;
      } else if (filter === 4) {
        const predictor = paethPredictor(left, up, upLeft);
        output[x] = (row[x] + predictor) & 255;
      } else {
        throw new Error(`${filePath} uses unsupported PNG filter ${filter}`);
      }
    }
  }

  return { width, height, pixels };
}

function paethPredictor(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);

  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
    return left;
  }

  return upDistance <= upLeftDistance ? up : upLeft;
}

function boundingBox(image, predicate) {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  let count = 0;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      const r = image.pixels[offset];
      const g = image.pixels[offset + 1];
      const b = image.pixels[offset + 2];
      const a = image.pixels[offset + 3];

      if (predicate(r, g, b, a)) {
        count += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  return {
    count,
    minX,
    minY,
    maxX,
    maxY,
    width: maxX >= minX ? maxX - minX + 1 : 0,
    height: maxY >= minY ? maxY - minY + 1 : 0,
  };
}

function whiteLogoBox(image) {
  return boundingBox(image, (r, g, b, a) => a > 0 && r > 128 && g > 128 && b > 128);
}

function alphaBox(image) {
  return boundingBox(image, (_r, _g, _b, a) => a > 8);
}

const referenceImage = parsePng(referenceIcon);
const referenceWhite = whiteLogoBox(referenceImage);
const referenceRatio = referenceWhite.width / referenceImage.width;
const failures = [];

for (const resourceRoot of resourceRoots) {
  for (const densityDir of densityDirs) {
    const foregroundPath = path.join(resourceRoot, densityDir, "ic_launcher_foreground.png");
    const image = parsePng(foregroundPath);
    const white = whiteLogoBox(image);
    const alpha = alphaBox(image);
    const visibleRatio = white.width / (image.width * adaptiveVisibleFraction);
    const alphaRatio = alpha.width / image.width;
    const ratioDrift = Math.abs(visibleRatio - referenceRatio);

    if (ratioDrift > maxRatioDrift) {
      failures.push(
        `${path.relative(appRoot, foregroundPath)} white logo uses ${(visibleRatio * 100).toFixed(1)}% of the Android visible zone; expected about ${(referenceRatio * 100).toFixed(1)}% from assets/ripple-launcher-icon-2048.png`,
      );
    }

    if (alphaRatio > referenceRatio * adaptiveVisibleFraction + 0.06) {
      failures.push(
        `${path.relative(appRoot, foregroundPath)} foreground alpha is too large (${(alphaRatio * 100).toFixed(1)}% of layer); Android foreground should be transparent outside the logo`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error("Android launcher icon safe-zone check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Android launcher icon safe-zone check passed. Reference visible logo width: ${(referenceRatio * 100).toFixed(1)}%.`,
);
