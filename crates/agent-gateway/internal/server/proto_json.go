// Shapes proto messages into JSON maps for the HTTP JSON endpoint (public share).
// protojson encodes int64/uint64 as strings and int32 as float64; here we recursively
// correct them to native numbers per the descriptor, keeping the external JSON shape
// consistent with the historical wire format (the public share page contract).
package server

import (
	"encoding/json"
	"reflect"
	"strconv"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

func protoJSONPayload(message proto.Message, useProtoNames bool) map[string]any {
	if message == nil || (reflect.ValueOf(message).Kind() == reflect.Pointer && reflect.ValueOf(message).IsNil()) {
		return nil
	}
	raw, err := protojson.MarshalOptions{
		UseProtoNames:   useProtoNames,
		EmitUnpopulated: true,
	}.Marshal(message)
	if err != nil {
		return map[string]any{}
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return map[string]any{}
	}
	coerceProtoJSONNumbers(payload, message.ProtoReflect().Descriptor(), useProtoNames)
	return payload
}

func coerceProtoJSONNumbers(payload map[string]any, descriptor protoreflect.MessageDescriptor, useProtoNames bool) {
	if payload == nil || descriptor == nil {
		return
	}
	fields := descriptor.Fields()
	for i := 0; i < fields.Len(); i++ {
		field := fields.Get(i)
		key := field.JSONName()
		if useProtoNames {
			key = field.TextName()
		}
		value, ok := payload[key]
		if !ok {
			continue
		}
		payload[key] = coerceProtoJSONField(value, field, useProtoNames)
	}
}

func coerceProtoJSONField(value any, field protoreflect.FieldDescriptor, useProtoNames bool) any {
	if field == nil || value == nil {
		return value
	}
	if field.IsList() {
		items, ok := value.([]any)
		if !ok {
			return value
		}
		for i, item := range items {
			items[i] = coerceProtoJSONScalarOrMessage(item, field, useProtoNames)
		}
		return items
	}
	return coerceProtoJSONScalarOrMessage(value, field, useProtoNames)
}

func coerceProtoJSONScalarOrMessage(value any, field protoreflect.FieldDescriptor, useProtoNames bool) any {
	if field.Kind() == protoreflect.MessageKind || field.Kind() == protoreflect.GroupKind {
		if nested, ok := value.(map[string]any); ok {
			coerceProtoJSONNumbers(nested, field.Message(), useProtoNames)
		}
		return value
	}
	switch field.Kind() {
	case protoreflect.Int32Kind, protoreflect.Sint32Kind, protoreflect.Sfixed32Kind:
		if number, ok := value.(float64); ok {
			return int32(number)
		}
	case protoreflect.Uint32Kind, protoreflect.Fixed32Kind:
		if number, ok := value.(float64); ok {
			return uint32(number)
		}
	case protoreflect.Int64Kind, protoreflect.Sint64Kind, protoreflect.Sfixed64Kind:
		if text, ok := value.(string); ok {
			if parsed, err := strconv.ParseInt(text, 10, 64); err == nil {
				return parsed
			}
		}
	case protoreflect.Uint64Kind, protoreflect.Fixed64Kind:
		if text, ok := value.(string); ok {
			if parsed, err := strconv.ParseUint(text, 10, 64); err == nil {
				return parsed
			}
		}
	}
	return value
}

func conversationSummaryPayload(conversation *gatewayv2.ConversationSummary) map[string]any {
	return protoJSONPayload(conversation, true)
}
