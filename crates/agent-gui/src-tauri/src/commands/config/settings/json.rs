fn serialize_json(value: &Value, label: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("Failed to serialize {label}: {e}"))
}

fn parse_json(raw: &str, label: &str) -> Result<Value, String> {
    serde_json::from_str::<Value>(raw).map_err(|e| format!("Failed to parse {label} JSON: {e}"))
}

fn expect_object(value: Value, label: &str) -> Result<Map<String, Value>, String> {
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(format!("{label} must be an object")),
    }
}

fn expect_array(value: Value, label: &str) -> Result<Vec<Value>, String> {
    match value {
        Value::Array(items) => Ok(items),
        _ => Err(format!("{label} must be an array")),
    }
}

fn extract_non_empty_string(
    object: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<String, String> {
    let value = object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{label}.{key} must not be empty"))?;
    Ok(value.to_string())
}

fn inject_string_field(object: &mut Map<String, Value>, key: &str, value: String) {
    object.insert(key.to_string(), Value::String(value));
}

fn extract_optional_string(object: &Map<String, Value>, key: &str) -> String {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn extract_bool_with_default(
    object: &Map<String, Value>,
    key: &str,
    label: &str,
    default: bool,
) -> Result<bool, String> {
    match object.get(key) {
        Some(Value::Bool(value)) => Ok(*value),
        Some(Value::Null) | None => Ok(default),
        Some(_) => Err(format!("{label}.{key} must be a boolean")),
    }
}

fn extract_string_array(value: Option<&Value>, label: &str) -> Result<Vec<String>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let items = value
        .as_array()
        .ok_or_else(|| format!("{label} must be an array of strings"))?;

    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let Some(text) = item.as_str() else {
            return Err(format!("{label} must be an array of strings"));
        };
        out.push(text.trim().to_string());
    }
    Ok(out)
}
