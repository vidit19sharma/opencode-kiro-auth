import { crc32, deflateSync } from "node:zlib"

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data])
  const length = Buffer.alloc(4), crc = Buffer.alloc(4)
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
export const PNG = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
  chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))),
  chunk("IEND", Buffer.alloc(0)),
]).toString("base64")
