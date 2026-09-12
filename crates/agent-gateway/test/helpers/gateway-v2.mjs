// v2 wire-protocol test codec: uses the same generated schema + protobuf runtime as the code under
// test to encode/decode binary frames, so FakeWebSocket can speak as the v2 server.
// Server frames are constructed in protojson shape (proto field names + the oneof arm as an ordinary
// field), with bytes fields passed as base64 strings.
export function createGatewayV2Codec(loader) {
  const pb = loader.loadModule("@bufbuild/protobuf");
  const v2 = loader.loadModule("src/lib/proto/gen/proto/v2/gateway_ws_pb.ts");

  const toBytes = (data) => {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    throw new Error("expected binary frame data");
  };

  // Encoded as an ArrayBuffer (the shape of event.data when the browser has binaryType="arraybuffer").
  const toArrayBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

  function decodeClientFrame(data) {
    const frame = pb.fromBinary(v2.WebClientFrameSchema, toBytes(data));
    const json = pb.toJson(v2.WebClientFrameSchema, frame, { useProtoFieldName: true });
    return {
      requestId: frame.requestId ?? "",
      case: frame.payload?.case,
      json,
      frame,
    };
  }

  // init is in protojson shape, e.g. { request_id: "r1", status: { online: true } }.
  function encodeServerFrame(init) {
    const frame = pb.fromJson(v2.WebServerFrameSchema, init);
    return toArrayBuffer(pb.toBinary(v2.WebServerFrameSchema, frame));
  }

  function decodeTerminalClientFrame(data) {
    const frame = pb.fromBinary(v2.TerminalClientFrameSchema, toBytes(data));
    const json = pb.toJson(v2.TerminalClientFrameSchema, frame, { useProtoFieldName: true });
    return { case: frame.payload?.case, json, frame };
  }

  function encodeTerminalServerFrame(init) {
    const frame = pb.fromJson(v2.TerminalServerFrameSchema, init);
    return toArrayBuffer(pb.toBinary(v2.TerminalServerFrameSchema, frame));
  }

  // The protojson form of a bytes field: strings as UTF-8, binary as-is, everything else JSON-serialized.
  const base64 = (value) => {
    if (value instanceof Uint8Array || Array.isArray(value)) {
      return Buffer.from(value).toString("base64");
    }
    return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString(
      "base64",
    );
  };

  return {
    pb,
    v2,
    decodeClientFrame,
    encodeServerFrame,
    decodeTerminalClientFrame,
    encodeTerminalServerFrame,
    base64,
  };
}
