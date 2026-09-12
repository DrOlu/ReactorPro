#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn open_memory_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        initialize_schema(&conn).expect("initialize schema");
        conn
    }

    fn table_columns(conn: &Connection, table: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("prepare table info");
        stmt.query_map([], |row| row.get::<_, String>(1))
            .expect("query table info")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect table columns")
    }

    #[test]
    fn save_system_preserves_sidebar_order_across_database_reopen() {
        let temp = tempfile::tempdir().expect("temp database");
        let path = temp.path().join("settings.sqlite");
        let order = json!(["/workspace/b", "/workspace/a"]);
        let pins = json!([
            "workspace:/workspace/a",
            "conversation:one",
            "workspace:/workspace/b"
        ]);
        {
            let mut conn = Connection::open(&path).expect("open database");
            initialize_schema(&conn).expect("initialize database");
            save_system_with_default_workdir(
                &mut conn,
                json!({
                    "workspaceProjectOrder": order,
                    "sidebarPinnedOrder": pins,
                }),
                "/workspace/default",
            )
            .expect("save sidebar preferences");
        }
        let mut conn = Connection::open(&path).expect("reopen database");
        let mut loaded =
            load_system_with_defaults(&conn, "/workspace/default").expect("load preferences");
        assert_eq!(loaded.get(SYSTEM_WORKSPACE_PROJECT_ORDER_KEY), Some(&order));
        assert_eq!(loaded.get(SYSTEM_SIDEBAR_PINNED_ORDER_KEY), Some(&pins));
        loaded["executionMode"] = json!("tools");
        save_system_with_default_workdir(&mut conn, loaded, "/workspace/default")
            .expect("save unrelated setting");
        let loaded = load_system(&conn)
            .expect("reload preferences")
            .expect("system settings");
        assert_eq!(loaded.get(SYSTEM_SIDEBAR_PINNED_ORDER_KEY), Some(&pins));
        assert_eq!(loaded.get(SYSTEM_WORKSPACE_PROJECT_ORDER_KEY), Some(&order));
    }

    #[test]
    fn initialize_schema_creates_all_tables() {
        let conn = open_memory_db();

        for table in [
            PROVIDER_SETTINGS_TABLE,
            SYSTEM_SETTINGS_TABLE,
            MCP_SETTINGS_TABLE,
            AGENT_PROMPT_TEMPLATES_TABLE,
            SSH_SETTINGS_TABLE,
            REMOTE_SETTINGS_TABLE,
            MEMORY_SETTINGS_TABLE,
            MODEL_FAILOVER_SETTINGS_TABLE,
            SSH_PROJECT_HOST_ASSOCIATIONS_TABLE,
            SSH_KNOWN_HOSTS_TABLE,
            BACKUP_SYNC_SETTINGS_TABLE,
        ] {
            let exists = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![table],
                    |row| row.get::<_, i64>(0),
                )
                .expect("query sqlite_master");
            assert_eq!(exists, 1, "table {table} should exist");
        }
    }

    #[test]
    fn ssh_patch_conflict_gateway_message_is_a_stable_code() {
        assert_eq!(
            SshPatchConflictCode::SettingsChanged.gateway_message(),
            "settings_changed"
        );
    }

    #[test]
    fn initialize_schema_creates_columnar_ssh_settings_table() {
        let conn = open_memory_db();
        let columns = table_columns(&conn, SSH_SETTINGS_TABLE);

        for column in [
            "host_id",
            "name",
            "description",
            "host",
            "port",
            "username",
            "auth_type",
            "password",
            "password_configured",
            "private_key",
            "private_key_path",
            "private_key_configured",
            "private_key_passphrase",
            "private_key_passphrase_configured",
            "proxy_json",
            "sort_index",
            "updated_at",
        ] {
            assert!(
                columns.iter().any(|item| item == column),
                "{SSH_SETTINGS_TABLE}.{column} should exist"
            );
        }
        assert!(
            !columns.iter().any(|item| item == "payload_json"),
            "{SSH_SETTINGS_TABLE}.payload_json should not exist"
        );
    }

    #[test]
    fn save_memory_persists_default_payload_and_sync_snapshot() {
        let mut conn = open_memory_db();
        let payload = json!({
            "organizerModel": {
                "customProviderId": "provider-a",
                "model": "gpt-5"
            },
            "summaryModel": {
                "customProviderId": "provider-a",
                "model": "gpt-5.4"
            }
        });

        save_memory(&mut conn, payload.clone()).expect("save memory settings");

        assert_eq!(
            load_memory(&conn).expect("load memory settings"),
            Some(payload.clone())
        );
        let snapshot =
            load_gateway_settings_sync_snapshot(&conn).expect("load gateway settings snapshot");
        assert_eq!(snapshot["memory"], payload);
    }

    #[test]
    fn normalize_remote_settings_repairs_single_slash_gateway_url() {
        let normalized = normalize_remote_settings_payload(RemoteSettingsPayload {
            enabled: true,
            gateway_url: " https:/agent.cnweb.org/ ".to_string(),
            gateway_port: 443,
            token: " agent-token-dev ".to_string(),
            agent_id: " mac-mini ".to_string(),
            auto_reconnect: true,
            heartbeat_interval: 30,
            enable_web_terminal: false,
            enable_web_ssh_terminal: false,
            enable_web_git: false,
            enable_web_tunnels: false,
        });

        assert_eq!(normalized.gateway_url, "https://agent.cnweb.org");
        assert_eq!(normalized.token, "agent-token-dev");
        assert_eq!(normalized.agent_id, "mac-mini");
    }

    #[test]
    fn ensure_remote_agent_id_migrates_legacy_grpc_port() {
        let mut conn = open_memory_db();
        let legacy = json!({
            "enabled": true,
            "gatewayUrl": "https://gateway.example.com",
            "grpcPort": 8443,
            "token": "gateway-token"
        });
        conn.execute(
            &format!(
                "INSERT INTO {REMOTE_SETTINGS_TABLE} (config_id, payload_json, updated_at)
                 VALUES ('default', ?1, ?2)"
            ),
            params![legacy.to_string(), now_ms()],
        )
        .expect("seed legacy remote settings");

        ensure_remote_agent_id(&mut conn).expect("migrate legacy remote settings");
        let migrated = load_remote_settings(&conn).expect("load migrated remote settings");
        let stored_json = conn
            .query_row(
                &format!(
                    "SELECT payload_json FROM {REMOTE_SETTINGS_TABLE} WHERE config_id = 'default'"
                ),
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("load stored remote payload");

        assert_eq!(migrated.gateway_port, 8443);
        assert!(is_generated_agent_id(&migrated.agent_id));
        assert!(stored_json.contains("\"gatewayPort\":8443"));
        assert!(!stored_json.contains("grpcPort"));
    }

    #[test]
    fn ensure_remote_agent_id_generates_once_and_survives_reopen() {
        let mut conn = open_memory_db();

        let first = ensure_remote_agent_id(&mut conn).expect("generate Agent ID");
        let second = ensure_remote_agent_id(&mut conn).expect("reload Agent ID");
        let stored = load_remote_settings(&conn).expect("load remote settings");

        assert!(is_generated_agent_id(&first), "generated id = {first}");
        assert_eq!(second, first);
        assert_eq!(stored.agent_id, first);
    }

    #[test]
    fn ensure_remote_agent_id_replaces_manual_id_and_preserves_remote_settings() {
        let mut conn = open_memory_db();
        persist_remote_settings(
            &conn,
            &RemoteSettingsPayload {
                enabled: true,
                gateway_url: "https://gateway.example.com".to_string(),
                gateway_port: 8443,
                token: "gateway-token".to_string(),
                agent_id: "liveagent".to_string(),
                auto_reconnect: false,
                heartbeat_interval: 45,
                enable_web_terminal: true,
                enable_web_ssh_terminal: true,
                enable_web_git: true,
                enable_web_tunnels: true,
            },
        )
        .expect("seed manual Agent ID");

        let generated = ensure_remote_agent_id(&mut conn).expect("replace manual Agent ID");
        let stored = load_remote_settings(&conn).expect("load remote settings");

        assert!(is_generated_agent_id(&generated));
        assert_eq!(stored.agent_id, generated);
        assert_eq!(stored.gateway_url, "https://gateway.example.com");
        assert_eq!(stored.gateway_port, 8443);
        assert_eq!(stored.token, "gateway-token");
        assert!(!stored.auto_reconnect);
        assert_eq!(stored.heartbeat_interval, 45);
        assert!(stored.enable_web_terminal);
        assert!(stored.enable_web_ssh_terminal);
        assert!(stored.enable_web_git);
        assert!(stored.enable_web_tunnels);
    }

    #[test]
    fn save_remote_cannot_override_persisted_agent_id() {
        let mut conn = open_memory_db();
        let generated = ensure_remote_agent_id(&mut conn).expect("generate Agent ID");

        let saved = save_remote(
            &mut conn,
            json!({
                "enabled": true,
                "gatewayUrl": "https://gateway.example.com",
                "gatewayPort": 443,
                "token": "gateway-token",
                "agentId": "attacker-controlled",
                "autoReconnect": true,
                "heartbeatInterval": 30
            }),
        )
        .expect("save remote settings");
        let stored = load_remote_settings(&conn).expect("load remote settings");

        assert_eq!(saved.agent_id, generated);
        assert_eq!(stored.agent_id, generated);
    }

    #[test]
    fn independent_installations_generate_different_agent_ids() {
        let mut first = open_memory_db();
        let mut second = open_memory_db();

        let first_id = ensure_remote_agent_id(&mut first).expect("generate first Agent ID");
        let second_id = ensure_remote_agent_id(&mut second).expect("generate second Agent ID");

        assert_ne!(first_id, second_id);
    }

    #[test]
    fn concurrent_initialization_keeps_one_agent_id() {
        let dir = tempfile::tempdir().expect("create temp directory");
        let path = dir.path().join("settings.sqlite");
        let conn = Connection::open(&path).expect("open shared settings db");
        initialize_schema(&conn).expect("initialize schema");
        drop(conn);

        let workers = (0..8)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let mut conn = Connection::open(path).expect("open shared settings db");
                    conn.busy_timeout(Duration::from_secs(5))
                        .expect("configure busy timeout");
                    ensure_remote_agent_id(&mut conn).expect("initialize Agent ID")
                })
            })
            .collect::<Vec<_>>();
        let ids = workers
            .into_iter()
            .map(|worker| worker.join().expect("join Agent ID initializer"))
            .collect::<Vec<_>>();

        assert!(ids.iter().all(|agent_id| agent_id == &ids[0]));
        assert!(is_generated_agent_id(&ids[0]));
    }

    #[test]
    fn save_providers_persists_one_row_per_provider_and_preserves_order() {
        let mut conn = open_memory_db();
        save_providers(
            &mut conn,
            json!([
                { "id": "provider-b", "name": "B" },
                { "id": "provider-a", "name": "A" }
            ]),
        )
        .expect("save providers");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM provider_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count provider rows");
        let loaded = load_providers(&conn).expect("load providers");

        assert_eq!(row_count, 2);
        assert_eq!(
            loaded,
            Some(json!([
                { "id": "provider-b", "name": "B" },
                { "id": "provider-a", "name": "A" }
            ]))
        );
    }

    #[test]
    fn gateway_settings_snapshot_redacts_provider_api_keys() {
        let mut conn = open_memory_db();
        save_providers(
            &mut conn,
            json!([
                {
                    "id": "provider-a",
                    "name": "A",
                    "apiKey": "secret-key",
                    "usageQuery": {
                        "apiKey": "usage-key",
                        "accessToken": "usage-token",
                        "secretAccessKey": "usage-secret"
                    },
                    "apiKeyConfigured": false
                },
                {
                    "id": "provider-b",
                    "name": "B",
                    "apiKey": "",
                    "apiKeyConfigured": true
                }
            ]),
        )
        .expect("save providers");

        let snapshot =
            load_gateway_settings_sync_snapshot(&conn).expect("load gateway settings snapshot");
        assert_eq!(snapshot["customProviders"][0]["apiKey"], Value::Null);
        assert_eq!(snapshot["customProviders"][0]["apiKeyConfigured"], true);
        assert_eq!(snapshot["customProviders"][0]["usageQuery"]["apiKey"], Value::Null);
        assert_eq!(
            snapshot["customProviders"][0]["usageQuery"]["apiKeyConfigured"],
            true
        );
        assert_eq!(snapshot["customProviders"][0]["usageQuery"]["accessToken"], Value::Null);
        assert_eq!(
            snapshot["customProviders"][0]["usageQuery"]["accessTokenConfigured"],
            true
        );
        assert_eq!(
            snapshot["customProviders"][0]["usageQuery"]["secretAccessKey"],
            Value::Null
        );
        assert_eq!(
            snapshot["customProviders"][0]["usageQuery"]["secretAccessKeyConfigured"],
            true
        );
        assert_eq!(snapshot["customProviders"][1]["apiKey"], Value::Null);
        assert_eq!(snapshot["customProviders"][1]["apiKeyConfigured"], true);
    }

    #[test]
    fn gateway_settings_payload_removes_usage_query_secret_sidecar() {
        let redacted = redact_gateway_settings_sync_payload(json!({
            "providerUsageQuerySecretUpdates": {
                "provider-a": {
                    "accessToken": "usage-token",
                    "secretAccessKey": "usage-secret"
                }
            }
        }))
        .expect("redact gateway settings payload");

        assert_eq!(redacted.get("providerUsageQuerySecretUpdates"), None);
    }

    #[test]
    fn save_ssh_persists_hosts_and_redacts_sync_snapshot() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [
                    {
                        "id": "prod",
                        "name": "Production",
                        "description": "Primary production host",
                        "host": "prod.example.com",
                        "port": "2222",
                        "username": "deploy",
                        "authType": "privateKey",
                        "password": "ssh-password",
                        "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----",
                        "privateKeyPath": "~/.ssh/id_ed25519",
                        "privateKeyPassphrase": "key-passphrase",
                        "proxy": {
                            "type": "http",
                            "url": "http://127.0.0.1",
                            "port": "1080",
                            "username": "proxy-user",
                            "password": "proxy-password",
                            "useSystemProxy": true
                        }
                    },
                    {
                        "id": "staging",
                        "name": "Staging",
                        "description": "",
                        "host": "staging.example.com",
                        "username": "ubuntu",
                        "authType": "password",
                        "passwordConfigured": true
                    }
                ],
                "projectHostAssociations": {
                    " /repo/project ": ["prod", "missing", "prod", "staging"],
                    "empty": ["missing"],
                    "  ": ["prod"]
                }
            }),
        )
        .expect("save ssh settings");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM ssh_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count ssh rows");
        let loaded = load_ssh(&conn).expect("load ssh settings");

        assert_eq!(row_count, 2);
        let stored = conn
            .query_row(
                "
                SELECT name, host, port, auth_type, private_key, private_key_passphrase, proxy_json
                FROM ssh_settings
                WHERE host_id = 'prod'
                ",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .expect("load stored ssh columns");
        assert_eq!(stored.0, "Production");
        assert_eq!(stored.1, "prod.example.com");
        assert_eq!(stored.2, 2222);
        assert_eq!(stored.3, "privateKey");
        assert_eq!(
            stored.4,
            "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----"
        );
        assert_eq!(stored.5, "key-passphrase");
        assert_eq!(
            parse_json(&stored.6, SSH_SETTINGS_TABLE).expect("parse proxy json"),
            json!({
                "type": "http",
                "url": "http://127.0.0.1",
                "port": 1080,
                "username": "proxy-user",
                "password": "proxy-password",
                "passwordConfigured": true,
                "useSystemProxy": true
            })
        );
        assert_eq!(
            loaded,
            Some(json!({
                "hosts": [
                    {
                        "id": "prod",
                        "name": "Production",
                        "description": "Primary production host",
                        "host": "prod.example.com",
                        "port": 2222,
                        "username": "deploy",
                        "authType": "privateKey",
                        "password": "ssh-password",
                        "passwordConfigured": true,
                        "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----",
                        "privateKeyPath": "~/.ssh/id_ed25519",
                        "privateKeyConfigured": true,
                        "privateKeyPassphrase": "key-passphrase",
                        "privateKeyPassphraseConfigured": true,
                        "proxy": {
                            "type": "http",
                            "url": "http://127.0.0.1",
                            "port": 1080,
                            "username": "proxy-user",
                            "password": "proxy-password",
                            "passwordConfigured": true,
                            "useSystemProxy": true
                        }
                    },
                    {
                        "id": "staging",
                        "name": "Staging",
                        "description": "",
                        "host": "staging.example.com",
                        "port": 22,
                        "username": "ubuntu",
                        "authType": "password",
                        "password": "",
                        "passwordConfigured": true,
                        "privateKey": "",
                        "privateKeyPath": "",
                        "privateKeyConfigured": false,
                        "privateKeyPassphrase": "",
                        "privateKeyPassphraseConfigured": false,
                        "proxy": {
                            "type": "socks5",
                            "url": "",
                            "port": 0,
                            "username": "",
                            "password": "",
                            "passwordConfigured": false,
                            "useSystemProxy": false
                        }
                    }
                ],
                "projectHostAssociations": {
                    "/repo/project": ["prod", "staging"]
                }
            }))
        );

        let snapshot =
            load_gateway_settings_sync_snapshot(&conn).expect("load gateway settings snapshot");
        assert_eq!(snapshot["ssh"]["hosts"][0]["password"], Value::Null);
        assert_eq!(snapshot["ssh"]["hosts"][0]["privateKey"], Value::Null);
        assert_eq!(
            snapshot["ssh"]["hosts"][0]["privateKeyPassphrase"],
            Value::Null
        );
        assert_eq!(snapshot["ssh"]["hosts"][0]["passwordConfigured"], true);
        assert_eq!(snapshot["ssh"]["hosts"][0]["privateKeyConfigured"], true);
        assert_eq!(
            snapshot["ssh"]["hosts"][0]["privateKeyPassphraseConfigured"],
            true
        );
        assert_eq!(
            snapshot["ssh"]["hosts"][0]["proxy"]["password"],
            Value::Null
        );
        assert_eq!(
            snapshot["ssh"]["hosts"][0]["proxy"]["passwordConfigured"],
            true
        );
        assert_eq!(snapshot["ssh"]["hosts"][1]["password"], Value::Null);
        assert_eq!(snapshot["ssh"]["hosts"][1]["privateKey"], Value::Null);
        assert_eq!(
            snapshot["ssh"]["hosts"][1]["privateKeyPassphrase"],
            Value::Null
        );
        assert_eq!(snapshot["ssh"]["hosts"][1]["passwordConfigured"], true);
        assert_eq!(
            snapshot["ssh"]["hosts"][1]["privateKeyPassphraseConfigured"],
            false
        );
        assert_eq!(
            snapshot["ssh"]["hosts"][1]["proxy"]["password"],
            Value::Null
        );
        assert_eq!(
            snapshot["ssh"]["hosts"][1]["proxy"]["passwordConfigured"],
            false
        );
        assert_eq!(
            snapshot["ssh"]["projectHostAssociations"],
            json!({
                "/repo/project": ["prod", "staging"]
            })
        );
    }

    #[test]
    fn save_ssh_keyboard_interactive_host_clears_credential_secret_state() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [
                    {
                        "id": "kbi-prod",
                        "name": "Keyboard Interactive Production",
                        "host": "prod.example.com",
                        "username": "deploy",
                        "authType": "keyboardInteractive",
                        "password": "old-password",
                        "passwordConfigured": true,
                        "privateKey": "old-key",
                        "privateKeyPath": "~/.ssh/id_rsa",
                        "privateKeyConfigured": true,
                        "privateKeyPassphrase": "old-passphrase",
                        "privateKeyPassphraseConfigured": true,
                        "proxy": {
                            "type": "http",
                            "url": "http://127.0.0.1",
                            "port": 8080,
                            "username": "proxy-user",
                            "password": "proxy-password"
                        }
                    }
                ]
            }),
        )
        .expect("save keyboard-interactive ssh settings");

        let loaded = load_ssh(&conn)
            .expect("load ssh settings")
            .expect("ssh settings should exist");
        let host = &loaded["hosts"][0];
        assert_eq!(host["authType"], "keyboardInteractive");
        assert_eq!(host["password"], "");
        assert_eq!(host["passwordConfigured"], false);
        assert_eq!(host["privateKey"], "");
        assert_eq!(host["privateKeyPath"], "");
        assert_eq!(host["privateKeyConfigured"], false);
        assert_eq!(host["privateKeyPassphrase"], "");
        assert_eq!(host["privateKeyPassphraseConfigured"], false);
        assert_eq!(host["proxy"]["passwordConfigured"], true);

        let snapshot =
            load_gateway_settings_sync_snapshot(&conn).expect("load gateway settings snapshot");
        assert_eq!(snapshot["ssh"]["hosts"][0]["password"], Value::Null);
        assert_eq!(snapshot["ssh"]["hosts"][0]["passwordConfigured"], false);
        assert_eq!(snapshot["ssh"]["hosts"][0]["privateKeyConfigured"], false);
        assert_eq!(
            snapshot["ssh"]["hosts"][0]["privateKeyPassphraseConfigured"],
            false
        );
    }

    #[test]
    fn initialize_schema_migrates_legacy_agent_auth_to_password() {
        let conn = open_memory_db();
        conn.execute(
            "
            INSERT INTO ssh_settings (
                host_id, name, description, host, port, username, auth_type,
                password, password_configured, private_key, private_key_path,
                private_key_configured, private_key_passphrase,
                private_key_passphrase_configured, proxy_json, sort_index, updated_at
            )
            VALUES ('legacy', 'Legacy', '', 'legacy.example.com', 22, 'deploy', 'agent',
                '', 0, '', '', 0, '', 0, '{}', 0, 0)
            ",
            [],
        )
        .expect("insert legacy agent host");

        initialize_schema(&conn).expect("re-run schema initialization");

        let auth_type: String = conn
            .query_row(
                "SELECT auth_type FROM ssh_settings WHERE host_id = 'legacy'",
                [],
                |row| row.get(0),
            )
            .expect("read migrated auth type");
        assert_eq!(auth_type, "password");
    }

    #[test]
    fn ssh_patch_delete_preserves_concurrent_hosts_and_associations() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [
                    {
                        "id": "prod",
                        "name": "Prod",
                        "host": "prod.example.com",
                        "username": "deploy",
                        "authType": "password"
                    },
                    {
                        "id": "staging",
                        "name": "Staging",
                        "host": "staging.example.com",
                        "username": "deploy",
                        "authType": "keyboardInteractive"
                    }
                ],
                "projectHostAssociations": {
                    "/repo": ["prod", "staging"]
                }
            }),
        )
        .expect("save ssh");

        let response = apply_ssh_patch_with_conn(
            &mut conn,
            json!({
                "sshPatch": {
                    "hostChanges": [{
                        "id": "prod",
                        "before": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password"
                        },
                        "after": null
                    }],
                    "projectAssociationChanges": [{
                        "pathKey": "/repo",
                        "before": ["prod"],
                        "after": []
                    }]
                }
            }),
        )
        .expect("apply patch");

        assert_eq!(response.conflict, None);
        assert_eq!(response.ssh["hosts"][0]["id"], "staging");
        assert_eq!(
            response.ssh["projectHostAssociations"],
            json!({
                "/repo": ["staging"]
            })
        );
    }

    #[test]
    fn ssh_patch_rejects_same_field_conflict() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [{
                    "id": "prod",
                    "name": "Prod New",
                    "host": "prod.example.com",
                    "username": "deploy",
                    "authType": "password"
                }]
            }),
        )
        .expect("save ssh");

        let response = apply_ssh_patch_with_conn(
            &mut conn,
            json!({
                "sshPatch": {
                    "hostChanges": [{
                        "id": "prod",
                        "before": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password"
                        },
                        "after": {
                            "id": "prod",
                            "name": "Prod Web",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password"
                        }
                    }]
                }
            }),
        )
        .expect("apply patch");

        assert_eq!(
            response.conflict,
            Some(SshPatchConflictCode::SettingsChanged)
        );
        assert_eq!(response.ssh["hosts"][0]["name"], "Prod New");
    }

    #[test]
    fn ssh_patch_merges_different_host_fields() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [{
                    "id": "prod",
                    "name": "Prod Desktop",
                    "host": "prod.example.com",
                    "username": "deploy",
                    "authType": "password"
                }]
            }),
        )
        .expect("save ssh");

        let response = apply_ssh_patch_with_conn(
            &mut conn,
            json!({
                "sshPatch": {
                    "hostChanges": [{
                        "id": "prod",
                        "before": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password"
                        },
                        "after": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.internal",
                            "username": "deploy",
                            "authType": "password"
                        }
                    }]
                }
            }),
        )
        .expect("apply patch");

        assert_eq!(response.conflict, None);
        assert_eq!(response.ssh["hosts"][0]["name"], "Prod Desktop");
        assert_eq!(response.ssh["hosts"][0]["host"], "prod.internal");
    }

    #[test]
    fn ssh_patch_rejects_auth_type_secret_conflict() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [{
                    "id": "prod",
                    "name": "Prod",
                    "host": "prod.example.com",
                    "username": "deploy",
                    "authType": "keyboardInteractive"
                }]
            }),
        )
        .expect("save ssh");

        let response = apply_ssh_patch_with_conn(
            &mut conn,
            json!({
                "sshPatch": {},
                "sshSecretUpdates": {
                    "prod": {
                        "password": "secret"
                    }
                }
            }),
        )
        .expect("apply patch");

        assert_eq!(
            response.conflict,
            Some(SshPatchConflictCode::SettingsChanged)
        );
    }

    #[test]
    fn ssh_patch_clears_empty_secret_updates() {
        let mut conn = open_memory_db();
        save_ssh(
            &mut conn,
            json!({
                "hosts": [{
                    "id": "prod",
                    "name": "Prod",
                    "host": "prod.example.com",
                    "username": "deploy",
                    "authType": "password",
                    "password": "old-password"
                }]
            }),
        )
        .expect("save ssh");

        let response = apply_ssh_patch_with_conn(
            &mut conn,
            json!({
                "sshPatch": {
                    "hostChanges": [{
                        "id": "prod",
                        "before": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password",
                            "passwordConfigured": true
                        },
                        "after": {
                            "id": "prod",
                            "name": "Prod",
                            "host": "prod.example.com",
                            "username": "deploy",
                            "authType": "password",
                            "passwordConfigured": false
                        }
                    }]
                },
                "sshSecretUpdates": {
                    "prod": {
                        "password": ""
                    }
                }
            }),
        )
        .expect("apply patch");

        assert_eq!(response.conflict, None);
        assert_eq!(response.ssh["hosts"][0]["password"], "");
        assert_eq!(response.ssh["hosts"][0]["passwordConfigured"], false);
    }

    #[test]
    fn ssh_known_hosts_tracks_unknown_known_and_changed_keys() {
        let conn = open_memory_db();
        let key = RuntimeSshKnownHostKey {
            host: "example.com".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            key_base64: "known-key".to_string(),
            fingerprint_sha256: "SHA256:known".to_string(),
        };

        assert_eq!(
            check_runtime_ssh_known_host_with_conn(&conn, &key).expect("check unknown host key"),
            RuntimeSshKnownHostStatus::Unknown
        );

        trust_runtime_ssh_known_host_with_conn(&conn, &key).expect("trust host key");
        assert_eq!(
            check_runtime_ssh_known_host_with_conn(&conn, &key).expect("check trusted host key"),
            RuntimeSshKnownHostStatus::Known
        );

        let changed = RuntimeSshKnownHostKey {
            key_base64: "changed-key".to_string(),
            fingerprint_sha256: "SHA256:changed".to_string(),
            ..key.clone()
        };
        assert_eq!(
            check_runtime_ssh_known_host_with_conn(&conn, &changed)
                .expect("check changed host key"),
            RuntimeSshKnownHostStatus::Changed {
                stored_fingerprint: "SHA256:known".to_string()
            }
        );

        assert_eq!(
            reset_runtime_ssh_known_host_with_conn(&conn, "example.com", 22)
                .expect("reset host key"),
            1
        );
        assert_eq!(
            check_runtime_ssh_known_host_with_conn(&conn, &key).expect("check reset host key"),
            RuntimeSshKnownHostStatus::Unknown
        );
        assert_eq!(
            reset_runtime_ssh_known_host_with_conn(&conn, "example.com", 22)
                .expect("reset missing host key"),
            0
        );
    }

    #[test]
    fn save_mcp_persists_one_row_per_server_and_restores_selection() {
        let mut conn = open_memory_db();
        save_mcp(
            &mut conn,
            json!({
                "servers": [
                    { "id": "alpha", "enabled": true, "transport": "stdio" },
                    { "id": "beta", "enabled": false, "transport": "http" }
                ],
                "selected": ["beta"]
            }),
        )
        .expect("save mcp");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM mcp_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count mcp rows");
        let selected_flag = conn
            .query_row(
                "SELECT payload_json FROM mcp_settings WHERE server_id = 'beta'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("query beta payload");
        let loaded = load_mcp(&conn).expect("load mcp");

        assert_eq!(row_count, 2);
        assert!(
            selected_flag.contains("\"selected\":true"),
            "selected flag should be stored inline"
        );
        assert_eq!(
            loaded,
            Some(json!({
                "servers": [
                    { "id": "alpha", "enabled": true, "transport": "stdio" },
                    { "id": "beta", "enabled": false, "transport": "http" }
                ],
                "selected": ["beta"]
            }))
        );
    }

    #[test]
    fn save_agents_persists_one_row_per_template_and_restores_columns() {
        let mut conn = open_memory_db();
        save_agents(
            &mut conn,
            json!([
                {
                    "id": "reviewer",
                    "name": "Code Review",
                    "description": "Used to review PRs and fill test gaps",
                    "prompt": "You are a strict code review assistant.",
                    "enabled": true
                },
                {
                    "id": "planner",
                    "name": "Task Planning",
                    "description": "",
                    "prompt": "Break down the tasks first, then execute.",
                    "enabled": false
                }
            ]),
        )
        .expect("save agents");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM agent_prompt_templates", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count agent rows");
        let stored_enabled = conn
            .query_row(
                "SELECT enabled FROM agent_prompt_templates WHERE template_id = 'reviewer'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("query reviewer enabled");
        let loaded = load_agents(&conn).expect("load agents");

        assert_eq!(row_count, 2);
        assert_eq!(stored_enabled, 1);
        assert_eq!(
            loaded,
            Some(json!([
                {
                    "id": "reviewer",
                    "name": "Code Review",
                    "description": "Used to review PRs and fill test gaps",
                    "prompt": "You are a strict code review assistant.",
                    "enabled": true
                },
                {
                    "id": "planner",
                    "name": "Task Planning",
                    "description": "",
                    "prompt": "Break down the tasks first, then execute.",
                    "enabled": false
                }
            ]))
        );
    }

    /// The normalized systemProxy default (shared by the full save/load assertions).
    fn default_system_proxy_json() -> Value {
        json!({
            "enabled": false,
            "type": "http",
            "host": "",
            "port": 0,
            "username": "",
            "password": "",
            "passwordConfigured": false
        })
    }

    #[test]
    fn save_system_persists_project_setting_rows() {
        let mut conn = open_memory_db();
        let default_workdir = default_project_workdir().expect("default workdir");
        save_system(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "E:/Code/test_directory/003",
                "toolPolicies": { "Bash": "ask", "server:docs-mcp": "deny" }
            }),
        )
        .expect("save system");

        let row_count = conn
            .query_row("SELECT COUNT(*) FROM system_settings", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count system rows");
        let keys = {
            let mut stmt = conn
                .prepare("SELECT setting_key FROM system_settings ORDER BY setting_key ASC")
                .expect("prepare key query");
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .expect("query keys");
            rows.into_iter()
                .map(|row| row.expect("key row"))
                .collect::<Vec<_>>()
        };
        let loaded = load_system(&conn).expect("load system");

        assert_eq!(row_count, 14);
        assert_eq!(
            keys,
            vec![
                SYSTEM_ACTIVE_WORKSPACE_PROJECT_ID_KEY.to_string(),
                SYSTEM_ARCHIVED_WORKSPACE_PROJECT_PATHS_KEY.to_string(),
                SYSTEM_BROWSER_AUTOMATION_MODE_KEY.to_string(),
                SYSTEM_COMMAND_SAFETY_MODE_KEY.to_string(),
                SYSTEM_CUA_ALLOW_SELF_TARGETING_KEY.to_string(),
                SYSTEM_EXECUTION_MODE_KEY.to_string(),
                SYSTEM_HIDDEN_WORKSPACE_PROJECT_PATHS_KEY.to_string(),
                SYSTEM_MISSING_WORKSPACE_PROJECT_PATHS_KEY.to_string(),
                SYSTEM_SYSTEM_PROXY_KEY.to_string(),
                SYSTEM_TOOL_POLICIES_KEY.to_string(),
                SYSTEM_WORKDIR_KEY.to_string(),
                SYSTEM_WORKSPACE_PROJECT_GROUPS_KEY.to_string(),
                SYSTEM_WORKSPACE_PROJECTS_KEY.to_string(),
                SYSTEM_WORKSPACE_RESOURCE_SETTINGS_KEY.to_string(),
            ]
        );
        assert_eq!(
            loaded,
            Some(json!({
                "activeWorkspaceProjectId": DEFAULT_WORKSPACE_PROJECT_ID,
                "cuaAllowSelfTargeting": false,
                "executionMode": "tools",
                "hiddenWorkspaceProjectPaths": [],
                "missingWorkspaceProjectPaths": [],
                "archivedWorkspaceProjectPaths": [],
                "workspaceResourceSettings": {},
                "commandSafetyMode": "auto",
                "browserAutomationMode": "auto",
                "systemProxy": default_system_proxy_json(),
                "workdir": default_workdir.clone(),
                "toolPolicies": { "Bash": "ask", "server:docs-mcp": "deny" },
                "workspaceProjectGroups": null,
                "workspaceProjects": [
                    {
                        "id": DEFAULT_WORKSPACE_PROJECT_ID,
                        "name": DEFAULT_WORKSPACE_PROJECT_NAME,
                        "path": default_workdir.clone(),
                        "kind": "managed",
                        "createdAt": 1,
                        "updatedAt": 1
                    }
                ]
            }))
        );
    }

    #[test]
    fn save_system_round_trips_archived_workspace_project_paths() {
        let mut conn = open_memory_db();
        save_system_with_default_workdir(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "/tmp/liveagent-default-project",
                "archivedWorkspaceProjectPaths": [
                    " /tmp/project-a ",
                    "/tmp/project-a",
                    "",
                    42
                ]
            }),
            "/tmp/liveagent-default-project",
        )
        .expect("save system");

        let loaded = load_system(&conn)
            .expect("load system")
            .expect("system settings");
        assert_eq!(
            loaded.get(SYSTEM_ARCHIVED_WORKSPACE_PROJECT_PATHS_KEY),
            Some(&json!(["/tmp/project-a"]))
        );
    }

    #[test]
    fn save_system_round_trips_workspace_project_groups() {
        let mut conn = open_memory_db();
        save_system_with_default_workdir(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "/tmp/liveagent-default-project",
                "workspaceProjectGroups": [
                    {
                        "id": "g1",
                        "name": "ReactorPro",
                        "projectPaths": ["/tmp/repo", "/tmp/wt"],
                        "sourceProjectPath": "/tmp/repo",
                        "collapsed": true,
                        "createdAt": 100,
                        "updatedAt": 100
                    }
                ]
            }),
            "/tmp/liveagent-default-project",
        )
        .expect("save system");

        let loaded = load_system(&conn)
            .expect("load system")
            .expect("system settings");
        assert_eq!(
            loaded.get(SYSTEM_WORKSPACE_PROJECT_GROUPS_KEY),
            Some(&json!([
                {
                    "id": "g1",
                    "name": "ReactorPro",
                    "projectPaths": ["/tmp/repo", "/tmp/wt"],
                    "sourceProjectPath": "/tmp/repo",
                    "collapsed": true,
                    "createdAt": 100,
                    "updatedAt": 100
                }
            ]))
        );
    }

    #[test]
    fn save_system_normalizes_workspace_resource_settings() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_millis() as u64;
        let mut conn = open_memory_db();
        save_system_with_default_workdir(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "/tmp/liveagent-default-project",
                "workspaceResourceSettings": {
                    "/tmp/project-a/": {
                        "mode": "custom",
                        "skillNames": ["review", "review", ""],
                        "mcpServerIds": ["github", "github", 42],
                        "projectPrompt": " Review this project. ",
                        "projectPromptStrategy": "replace",
                        "stateVersion": 3,
                        "writerId": " client-a ",
                        "updatedAt": 100
                    },
                    "/tmp/project-b": {
                        "mode": "inherit",
                        "skillNames": ["ignored"],
                        "mcpServerIds": ["ignored"],
                        "projectPrompt": 42,
                        "projectPromptStrategy": "invalid",
                        "stateVersion": 4,
                        "writerId": "client-b",
                        "updatedAt": now
                    }
                }
            }),
            "/tmp/liveagent-default-project",
        )
        .expect("save system");

        let loaded = load_system(&conn)
            .expect("load system")
            .expect("system settings");
        assert_eq!(
            loaded.get(SYSTEM_WORKSPACE_RESOURCE_SETTINGS_KEY),
            Some(&json!({
                "/tmp/project-a": {
                    "mode": "custom",
                    "skillNames": ["review"],
                    "mcpServerIds": ["github"],
                    "projectPrompt": "Review this project.",
                    "projectPromptStrategy": "replace",
                    "stateVersion": 3,
                    "writerId": "client-a",
                    "updatedAt": 100
                },
                "/tmp/project-b": {
                    "mode": "inherit",
                    "skillNames": [],
                    "mcpServerIds": [],
                    "projectPrompt": "",
                    "projectPromptStrategy": "append",
                    "stateVersion": 4,
                    "writerId": "client-b",
                    "updatedAt": now
                }
            }))
        );
    }

    #[test]
    fn workspace_resource_settings_are_not_truncated_after_one_hundred_paths() {
        let entries = (0..150)
            .map(|index| {
                (
                    format!("/tmp/project-{index}"),
                    json!({
                        "mode": "custom",
                        "skillNames": [format!("skill-{index}")],
                        "mcpServerIds": [],
                        "stateVersion": 1,
                        "writerId": "test",
                        "updatedAt": index + 1
                    }),
                )
            })
            .collect::<Map<String, Value>>();
        let normalized = normalize_workspace_resource_settings(Some(&Value::Object(entries)));
        let normalized = normalized.as_object().expect("normalized workspace resources");
        assert_eq!(normalized.len(), 150);
        assert_eq!(
            normalized["/tmp/project-149"]["skillNames"],
            json!(["skill-149"])
        );
    }

    #[test]
    fn workspace_resource_settings_expire_only_old_inherit_tombstones() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_millis() as u64;
        let old = now - WORKSPACE_RESOURCE_TOMBSTONE_TTL_MS - 1;
        let normalized = normalize_workspace_resource_settings(Some(&json!({
            "/tmp/old-tombstone": {
                "mode": "inherit",
                "stateVersion": 1,
                "updatedAt": old
            },
            "/tmp/custom": {
                "mode": "custom",
                "skillNames": ["kept"],
                "stateVersion": 1,
                "updatedAt": old
            },
            "/tmp/off": {
                "mode": "off",
                "stateVersion": 1,
                "updatedAt": old
            },
            "/tmp/recent-tombstone": {
                "mode": "inherit",
                "stateVersion": 1,
                "updatedAt": now
            },
            "/tmp/project-prompt": {
                "mode": "inherit",
                "projectPrompt": " Keep project context ",
                "projectPromptStrategy": "replace",
                "stateVersion": 1,
                "updatedAt": old
            }
        })));
        let normalized = normalized.as_object().expect("normalized workspace resources");
        assert!(!normalized.contains_key("/tmp/old-tombstone"));
        assert_eq!(normalized["/tmp/custom"]["mode"], "custom");
        assert_eq!(normalized["/tmp/off"]["mode"], "off");
        assert_eq!(normalized["/tmp/recent-tombstone"]["mode"], "inherit");
        assert_eq!(
            normalized["/tmp/project-prompt"]["projectPrompt"],
            "Keep project context"
        );
        assert_eq!(
            normalized["/tmp/project-prompt"]["projectPromptStrategy"],
            "replace"
        );
    }

    #[test]
    fn workspace_resource_overflow_prefers_active_entries_and_newest_tombstones() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_millis() as u64;
        let mut entries = Map::new();
        for index in 0..250_u64 {
            entries.insert(
                format!("/tmp/tombstone-{index:03}"),
                json!({
                    "mode": "inherit",
                    "stateVersion": 1,
                    "updatedAt": now - index
                }),
            );
        }
        for index in 0..20_u64 {
            entries.insert(
                format!("/tmp/custom-{index:02}"),
                json!({
                    "mode": if index % 2 == 0 { "custom" } else { "off" },
                    "skillNames": [format!("skill-{index}")],
                    "stateVersion": 1,
                    "updatedAt": now - 1_000_000 - index
                }),
            );
        }
        entries.insert(
            "/tmp/project-prompt".to_string(),
            json!({
                "mode": "inherit",
                "projectPrompt": "Keep project context",
                "projectPromptStrategy": "append",
                "stateVersion": 1,
                "updatedAt": 1
            }),
        );
        let normalized = normalize_workspace_resource_settings(Some(&Value::Object(entries)));
        let normalized = normalized.as_object().expect("normalized workspace resources");
        assert_eq!(normalized.len(), MAX_WORKSPACE_RESOURCE_SETTINGS);
        for index in 0..20 {
            assert!(normalized.contains_key(&format!("/tmp/custom-{index:02}")));
        }
        assert!(normalized.contains_key("/tmp/project-prompt"));
        assert!(normalized.contains_key("/tmp/tombstone-234"));
        assert!(!normalized.contains_key("/tmp/tombstone-235"));
    }

    #[test]
    fn workspace_resource_overflow_uses_unicode_code_point_ordering() {
        let mut entries = Map::new();
        for index in 0..253 {
            entries.insert(
                format!("/tmp/{index:03}"),
                json!({ "mode": "off", "stateVersion": 1, "updatedAt": 1 }),
            );
        }
        for suffix in ["A", "_", "a", "ä"] {
            entries.insert(
                format!("/tmp/{suffix}"),
                json!({ "mode": "off", "stateVersion": 1, "updatedAt": 1 }),
            );
        }
        let normalized = normalize_workspace_resource_settings(Some(&Value::Object(entries)));
        let normalized = normalized.as_object().expect("normalized workspace resources");
        assert_eq!(normalized.len(), MAX_WORKSPACE_RESOURCE_SETTINGS);
        assert!(normalized.contains_key("/tmp/A"));
        assert!(normalized.contains_key("/tmp/_"));
        assert!(normalized.contains_key("/tmp/a"));
        assert!(!normalized.contains_key("/tmp/ä"));
    }

    #[test]
    fn save_system_backfills_empty_workdir_with_default_project() {
        let mut conn = open_memory_db();
        save_system_with_default_workdir(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "",
            }),
            "/tmp/liveagent-default-project",
        )
        .expect("save system");

        let loaded = load_system(&conn).expect("load system");
        assert_eq!(
            loaded,
            Some(json!({
                "activeWorkspaceProjectId": DEFAULT_WORKSPACE_PROJECT_ID,
                "cuaAllowSelfTargeting": false,
                "executionMode": "tools",
                "hiddenWorkspaceProjectPaths": [],
                "missingWorkspaceProjectPaths": [],
                "archivedWorkspaceProjectPaths": [],
                "workspaceResourceSettings": {},
                "commandSafetyMode": "auto",
                "browserAutomationMode": "auto",
                "systemProxy": default_system_proxy_json(),
                "workdir": "/tmp/liveagent-default-project",
                "toolPolicies": null,
                "workspaceProjectGroups": null,
                "workspaceProjects": [
                    {
                        "id": DEFAULT_WORKSPACE_PROJECT_ID,
                        "name": DEFAULT_WORKSPACE_PROJECT_NAME,
                        "path": "/tmp/liveagent-default-project",
                        "kind": "managed",
                        "createdAt": 1,
                        "updatedAt": 1
                    }
                ]
            }))
        );
    }

    #[test]
    fn save_system_preserves_default_project_pin_metadata() {
        let mut conn = open_memory_db();
        save_system_with_default_workdir(
            &mut conn,
            json!({
                "executionMode": "tools",
                "workdir": "/tmp/liveagent-default-project",
                "workspaceProjects": [
                    {
                        "id": DEFAULT_WORKSPACE_PROJECT_ID,
                        "name": DEFAULT_WORKSPACE_PROJECT_NAME,
                        "path": "/tmp/liveagent-default-project",
                        "kind": "managed",
                        "createdAt": 10,
                        "updatedAt": 20,
                        "isPinned": true,
                        "pinnedAt": 30
                    }
                ]
            }),
            "/tmp/liveagent-default-project",
        )
        .expect("save system");

        let loaded = load_system(&conn).expect("load system");
        assert_eq!(
            loaded,
            Some(json!({
                "activeWorkspaceProjectId": DEFAULT_WORKSPACE_PROJECT_ID,
                "cuaAllowSelfTargeting": false,
                "executionMode": "tools",
                "hiddenWorkspaceProjectPaths": [],
                "missingWorkspaceProjectPaths": [],
                "archivedWorkspaceProjectPaths": [],
                "workspaceResourceSettings": {},
                "commandSafetyMode": "auto",
                "browserAutomationMode": "auto",
                "systemProxy": default_system_proxy_json(),
                "workdir": "/tmp/liveagent-default-project",
                "toolPolicies": null,
                "workspaceProjectGroups": null,
                "workspaceProjects": [
                    {
                        "id": DEFAULT_WORKSPACE_PROJECT_ID,
                        "name": DEFAULT_WORKSPACE_PROJECT_NAME,
                        "path": "/tmp/liveagent-default-project",
                        "kind": "managed",
                        "createdAt": 1,
                        "updatedAt": 1,
                        "isPinned": true,
                        "pinnedAt": 30
                    }
                ]
            }))
        );
    }

    // P2#6: an unrecognized command safety mode must converge to the strict side
    // (ask), not silently degrade to auto — save_system destructively writes the
    // normalized result back to disk.
    #[test]
    fn command_safety_mode_unrecognized_value_fails_closed_to_ask() {
        // Missing / null / empty string: normal default forms, keep auto.
        assert_eq!(normalize_command_safety_mode_value(None), json!("auto"));
        assert_eq!(
            normalize_command_safety_mode_value(Some(&Value::Null)),
            json!("auto")
        );
        assert_eq!(
            normalize_command_safety_mode_value(Some(&json!("   "))),
            json!("auto")
        );
        // Legal values are preserved as-is (including whitespace trimming).
        for mode in ["ask", "auto", "sandbox", "sandboxOffline"] {
            assert_eq!(
                normalize_command_safety_mode_value(Some(&json!(format!(" {mode} ")))),
                json!(mode)
            );
        }
        // Future mode values / older-version rollback / manual typos / type errors: all converge to ask.
        assert_eq!(
            normalize_command_safety_mode_value(Some(&json!("sandboxStrictest"))),
            json!("ask")
        );
        assert_eq!(
            normalize_command_safety_mode_value(Some(&json!("Auto"))),
            json!("ask")
        );
        assert_eq!(
            normalize_command_safety_mode_value(Some(&json!(1))),
            json!("ask")
        );
    }

    #[test]
    fn load_system_with_defaults_returns_agent_mode_and_default_project() {        let conn = open_memory_db();
        let loaded = load_system_with_defaults(&conn, "/tmp/liveagent-default-project")
            .expect("load system");

        assert_eq!(
            loaded,
            json!({
                "activeWorkspaceProjectId": DEFAULT_WORKSPACE_PROJECT_ID,
                "cuaAllowSelfTargeting": false,
                "executionMode": "tools",
                "hiddenWorkspaceProjectPaths": [],
                "missingWorkspaceProjectPaths": [],
                "archivedWorkspaceProjectPaths": [],
                "workspaceResourceSettings": {},
                "commandSafetyMode": "auto",
                "browserAutomationMode": "auto",
                "systemProxy": default_system_proxy_json(),
                "workdir": "/tmp/liveagent-default-project",
                "workspaceProjects": [
                    {
                        "id": DEFAULT_WORKSPACE_PROJECT_ID,
                        "name": DEFAULT_WORKSPACE_PROJECT_NAME,
                        "path": "/tmp/liveagent-default-project",
                        "kind": "managed",
                        "createdAt": 1,
                        "updatedAt": 1
                    }
                ]
            })
        );
    }

    #[test]
    fn expand_home_prefix_supports_bare_tilde() {
        let home = dirs::home_dir().expect("home dir available in tests");
        assert_eq!(expand_home_prefix("~"), home);
    }

    #[test]
    fn expand_home_prefix_supports_forward_slash() {
        let home = dirs::home_dir().expect("home dir available in tests");
        assert_eq!(
            expand_home_prefix("~/OneDrive/ccswitch"),
            home.join("OneDrive/ccswitch")
        );
    }

    #[test]
    fn expand_home_prefix_supports_windows_backslash() {
        let home = dirs::home_dir().expect("home dir available in tests");
        assert_eq!(
            expand_home_prefix("~\\OneDrive\\ccswitch"),
            home.join("OneDrive\\ccswitch")
        );
    }

    #[test]
    fn expand_home_prefix_passes_through_absolute_paths() {
        assert_eq!(
            expand_home_prefix("/data/ccswitch"),
            PathBuf::from("/data/ccswitch")
        );
        assert_eq!(
            expand_home_prefix("C:\\Users\\Alice\\ccswitch"),
            PathBuf::from("C:\\Users\\Alice\\ccswitch")
        );
    }

    #[cfg(windows)]
    #[test]
    fn ccswitch_db_candidates_include_home_env_fallback_on_windows() {
        // The candidate list must cover ccswitch v3.10.3's legacy database location under `%HOME%\.cc-switch\`.
        let previous = std::env::var("HOME").ok();
        std::env::set_var("HOME", "C:\\legacy-home");
        let candidates = ccswitch_db_candidates();
        match previous {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }

        let expected = PathBuf::from("C:\\legacy-home")
            .join(".cc-switch")
            .join("cc-switch.db");
        assert!(candidates.contains(&expected));
    }

    #[test]
    fn cherry_split_v1_api_keys_handles_escaped_commas() {
        assert_eq!(
            cherry_split_v1_api_keys(r"first\,part, second, ,third"),
            vec!["first,part", "second", "third"]
        );
    }

    #[test]
    fn cherry_manual_data_candidates_support_portable_and_nested_directories() {
        let root = tempfile::tempdir().expect("tempdir");
        let portable = root.path().join("CherryStudioPortable");
        let data = portable.join("data");
        let local_storage = data.join("Local Storage");
        let leveldb = local_storage.join("leveldb");

        let portable_candidates = cherry_manual_data_candidates(&portable);
        assert!(portable_candidates.contains(&portable));
        assert!(portable_candidates.contains(&data));

        let local_storage_candidates = cherry_manual_data_candidates(&local_storage);
        assert!(local_storage_candidates.contains(&data));

        let leveldb_candidates = cherry_manual_data_candidates(&leveldb);
        assert!(leveldb_candidates.contains(&data));
    }

    #[test]
    fn cherry_normalize_routed_base_url_removes_endpoint_marker() {
        assert_eq!(
            cherry_normalize_routed_base_url("https://example.test/v1/chat/completions#"),
            "https://example.test/v1"
        );
        assert_eq!(
            cherry_normalize_routed_base_url(
                "https://generativelanguage.googleapis.com/v1beta/models/demo:generateContent#"
            ),
            "https://generativelanguage.googleapis.com/v1beta/models/demo"
        );
    }

    #[test]
    fn cherry_v1_new_api_splits_chat_protocols_and_filters_non_chat_models() {
        let provider = json!({
            "id": "mixed-provider",
            "name": "Mixed API",
            "type": "new-api",
            "apiKey": "secret",
            "apiHost": "https://example.test/v1",
            "enabled": true,
            "models": [
                { "id": "gpt-chat", "endpoint_type": "openai-chat-completions", "type": ["text"] },
                { "id": "claude-chat", "endpoint_type": "anthropic-messages", "type": ["text"] },
                { "id": "text-embedding-3-small", "endpoint_type": "openai-chat-completions", "type": ["embedding"] }
            ]
        });
        let mut imported = Vec::new();

        cherry_append_v1_provider(&provider, "1.9.9", &mut imported);

        assert_eq!(imported.len(), 2);
        assert!(imported.iter().all(|item| item.importable));
        assert!(imported.iter().all(|item| item.api_key == "secret"));
        assert!(imported.iter().all(|item| item.excluded_model_count == 1));
        assert!(!cherry_model_is_chat_compatible(
            &json!({"type": ["image_generation"]}),
            "nano-banana"
        ));
        assert!(imported.iter().any(|item| {
            item.provider_type == "codex" && item.request_format == "openai-completions"
        }));
        assert!(imported
            .iter()
            .any(|item| item.provider_type == "claude_code"));
    }

    #[test]
    fn cherry_v1_routes_official_deepseek_chat_to_deepseek_provider() {
        let provider = json!({
            "id": "official-deepseek",
            "name": "DeepSeek Official",
            "type": "openai",
            "apiKey": "secret",
            "apiHost": "https://api.deepseek.com/v1/chat/completions#",
            "models": [
                { "id": "deepseek-chat", "endpoint_type": "openai-chat-completions", "type": ["text"] }
            ]
        });
        let mut imported = Vec::new();

        cherry_append_v1_provider(&provider, "1.9.9", &mut imported);

        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].provider_type, "deepseek");
        assert_eq!(imported[0].request_format, "openai-completions");
        assert_eq!(imported[0].base_url, "https://api.deepseek.com/v1");
    }

    #[test]
    fn cherry_v1_keeps_third_party_deepseek_model_in_codex_provider() {
        let provider = json!({
            "id": "aggregate-gateway",
            "name": "Aggregate Gateway",
            "type": "openai",
            "apiKey": "secret",
            "apiHost": "https://relay.example.test/v1",
            "models": [
                { "id": "deepseek-chat", "endpoint_type": "openai-chat-completions", "type": ["text"] }
            ]
        });
        let mut imported = Vec::new();

        cherry_append_v1_provider(&provider, "1.9.9", &mut imported);

        assert_eq!(imported.len(), 1);
        assert_eq!(imported[0].provider_type, "codex");
        assert_eq!(imported[0].request_format, "openai-completions");
    }

    #[test]
    fn ccs_maps_grokbuild_app_type_to_xai() {
        assert_eq!(
            ccs_provider_type_from_app_type("grokbuild"),
            Some("xai")
        );
        assert_eq!(ccs_provider_type_from_app_type("grok"), Some("xai"));
        assert_eq!(ccs_provider_type_from_app_type("xai"), Some("xai"));
        assert_eq!(ccs_provider_type_from_app_type("Grok-Build"), Some("xai"));
    }

    #[test]
    fn ccs_imports_deepseek_app_type_and_environment_fields() {
        let config = json!({
            "env": {
                "DEEPSEEK_BASE_URL": "https://api.deepseek.com/v1/",
                "DEEPSEEK_API_KEY": "sk-deepseek",
                "DEEPSEEK_MODEL": "deepseek-chat",
                "DEEPSEEK_REASONER_MODEL": "deepseek-reasoner"
            }
        });
        let item = ccs_provider_from_value(
            "deepseek-official",
            "deepseek",
            "DeepSeek Official",
            &config,
            &json!({}),
        )
        .expect("deepseek provider should import");

        assert_eq!(item.provider_type, "deepseek");
        assert_eq!(item.base_url, "https://api.deepseek.com/v1");
        assert_eq!(item.api_key, "sk-deepseek");
        assert_eq!(item.request_format, "openai-completions");
        assert_eq!(item.models, vec!["deepseek-chat", "deepseek-reasoner"]);
    }

    #[test]
    fn ccs_reclassifies_only_official_deepseek_codex_chat_configs() {
        let official = json!({
            "auth": { "OPENAI_API_KEY": "sk-official" },
            "config": "model = \"deepseek-chat\"\nmodel_provider = \"deepseek\"\n\n[model_providers.deepseek]\nbase_url = \"https://api.deepseek.com/v1\"\nwire_api = \"chat\"\n"
        });
        let aggregate = json!({
            "auth": { "OPENAI_API_KEY": "sk-relay" },
            "config": "model = \"deepseek-chat\"\nmodel_provider = \"relay\"\n\n[model_providers.relay]\nbase_url = \"https://relay.example.test/v1\"\nwire_api = \"chat\"\n"
        });

        let official_item =
            ccs_provider_from_value("official", "codex", "Official", &official, &json!({}))
                .expect("official config should import");
        let aggregate_item =
            ccs_provider_from_value("aggregate", "codex", "Aggregate", &aggregate, &json!({}))
                .expect("aggregate config should import");

        assert_eq!(official_item.provider_type, "deepseek");
        assert_eq!(official_item.request_format, "openai-completions");
        assert_eq!(aggregate_item.provider_type, "codex");
        assert_eq!(aggregate_item.request_format, "openai-completions");
    }

    #[test]
    fn ccs_imports_grokbuild_toml_config_fields() {
        // Aligned with the shape CC-Switch Grok Build writes into providers.settings_config:
        // config is TOML text containing the [models].default and [model."<id>"] tables.
        let config = json!({
            "config": "[models]\ndefault = \"grok-4.5\"\n\n[model]\n[model.\"grok-4.5\"]\nmodel = \"grok-4.5\"\nbase_url = \"https://api.x.ai/v1\"\nname = \"packy\"\napi_backend = \"responses\"\ncontext_window = 500000\napi_key = \"sk-test-key\"\n"
        });
        let item = ccs_provider_from_value(
            "d262e762-test",
            "grokbuild",
            "PackyCode",
            &config,
            &json!({}),
        )
        .expect("grokbuild provider should import");

        assert_eq!(item.provider_type, "xai");
        assert_eq!(item.app_type, "grokbuild");
        assert_eq!(item.base_url, "https://api.x.ai/v1");
        assert_eq!(item.api_key, "sk-test-key");
        assert_eq!(item.request_format, "openai-responses");
        assert!(item.models.iter().any(|m| m == "grok-4.5"));
    }

    #[test]
    fn ccs_imports_empty_official_grokbuild_seed() {
        let config = json!({ "config": "" });
        let item = ccs_provider_from_value(
            "grokbuild-official",
            "grokbuild",
            "Grok Official",
            &config,
            &json!({}),
        )
        .expect("official grok seed should still map");
        assert_eq!(item.provider_type, "xai");
        assert_eq!(item.base_url, "");
        assert_eq!(item.api_key, "");
        assert_eq!(item.request_format, "openai-responses");
    }

    #[test]
    fn ccs_maps_claude_desktop_app_type_to_claude_code() {
        assert_eq!(
            ccs_provider_type_from_app_type("claude-desktop"),
            Some("claude_code")
        );
        assert_eq!(
            ccs_provider_type_from_app_type("claude_desktop"),
            Some("claude_code")
        );
        assert_eq!(
            ccs_provider_type_from_app_type("claudeDesktop"),
            Some("claude_code")
        );
    }

    #[test]
    fn ccs_imports_claude_desktop_direct_mode_provider() {
        // Aligned with the shape cc-switch writes to the DB for Claude Desktop direct mode:
        // env stores ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN, and models live in meta's routing table.
        let config = json!({
            "env": {
                "ANTHROPIC_BASE_URL": "https://relay.example.test/",
                "ANTHROPIC_AUTH_TOKEN": "sk-desktop"
            }
        });
        let meta = json!({
            "claudeDesktopMode": "direct",
            "apiFormat": "anthropic",
            "claudeDesktopModelRoutes": {
                "claude-sonnet-4-5": { "model": "claude-sonnet-4-5" },
                "claude-opus-4-5": { "model": "claude-opus-4-5" }
            }
        });
        let item = ccs_provider_from_value(
            "desktop-1",
            "claude-desktop",
            "Desktop Relay",
            &config,
            &meta,
        )
        .expect("claude desktop direct provider should import");

        assert_eq!(item.provider_type, "claude_code");
        assert_eq!(item.app_type, "claude-desktop");
        assert_eq!(item.base_url, "https://relay.example.test");
        assert_eq!(item.api_key, "sk-desktop");
        assert_eq!(
            item.models,
            vec!["claude-opus-4-5", "claude-sonnet-4-5"]
        );
    }

    #[test]
    fn ccs_imports_claude_desktop_proxy_mode_anthropic_upstream() {
        // Mapping mode + Anthropic upstream: the model comes from route.model (the real upstream model).
        let config = json!({
            "env": {
                "ANTHROPIC_BASE_URL": "https://gateway.example.test",
                "ANTHROPIC_API_KEY": "sk-proxy"
            }
        });
        let meta = json!({
            "claudeDesktopMode": "proxy",
            "apiFormat": "anthropic",
            "claudeDesktopModelRoutes": {
                "claude-sonnet-4-5": { "model": "kimi-k2", "labelOverride": "Kimi" }
            }
        });
        let item = ccs_provider_from_value(
            "desktop-2",
            "claude-desktop",
            "Desktop Proxy",
            &config,
            &meta,
        )
        .expect("anthropic-format proxy provider should import");

        assert_eq!(item.provider_type, "claude_code");
        assert_eq!(item.api_key, "sk-proxy");
        assert_eq!(item.models, vec!["kimi-k2"]);
    }

    #[test]
    fn ccs_skips_claude_desktop_non_anthropic_upstreams() {
        // When mapping mode declares an openai_chat / openai_responses / gemini_native upstream,
        // it relies on cc-switch's built-in gateway to translate protocols and cannot be imported
        // directly as an Anthropic provider.
        let config = json!({
            "env": {
                "ANTHROPIC_BASE_URL": "https://api.openai.example.test/v1",
                "ANTHROPIC_AUTH_TOKEN": "sk-openai"
            }
        });
        for format in ["openai_chat", "openai_responses", "gemini_native"] {
            let meta = json!({
                "claudeDesktopMode": "proxy",
                "apiFormat": format,
                "claudeDesktopModelRoutes": {
                    "claude-sonnet-4-5": { "model": "gpt-5.2" }
                }
            });
            assert!(
                ccs_provider_from_value("desktop-3", "claude-desktop", "GPT", &config, &meta)
                    .is_none(),
                "{format} upstream should be skipped"
            );
        }
    }

    #[test]
    fn ccs_imports_claude_desktop_official_seed_without_meta_format() {
        // The official seed settings_config is {"env":{}} with no apiFormat in meta:
        // it should be treated as Anthropic and kept (the frontend greys it out with empty base_url/api_key).
        let config = json!({ "env": {} });
        let item = ccs_provider_from_value(
            "claude-desktop-official",
            "claude-desktop",
            "Claude Desktop Official",
            &config,
            &json!({}),
        )
        .expect("official claude desktop seed should map");
        assert_eq!(item.provider_type, "claude_code");
        assert_eq!(item.base_url, "");
        assert_eq!(item.api_key, "");
        assert!(item.models.is_empty());
    }

    #[test]
    fn ccs_db_query_returns_claude_desktop_rows_with_meta() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("cc-switch.db");
        {
            let conn = Connection::open(&db_path).expect("create ccswitch db");
            conn.execute_batch(
                "CREATE TABLE providers (
                   id TEXT NOT NULL,
                   app_type TEXT NOT NULL,
                   name TEXT NOT NULL,
                   settings_config TEXT NOT NULL,
                   category TEXT,
                   created_at INTEGER,
                   sort_index INTEGER,
                   meta TEXT NOT NULL DEFAULT '{}',
                   is_current BOOLEAN NOT NULL DEFAULT 0,
                   PRIMARY KEY (id, app_type)
                 );",
            )
            .expect("create providers table");
            let insert = |id: &str, app_type: &str, name: &str, config: &str, meta: &str| {
                conn.execute(
                    "INSERT INTO providers (id, app_type, name, settings_config, meta, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, 1)",
                    rusqlite::params![id, app_type, name, config, meta],
                )
                .expect("insert provider row");
            };
            insert(
                "cli-1",
                "claude",
                "CLI Relay",
                r#"{"env":{"ANTHROPIC_BASE_URL":"https://cli.example.test","ANTHROPIC_AUTH_TOKEN":"sk-cli"}}"#,
                "{}",
            );
            insert(
                "desktop-direct",
                "claude-desktop",
                "Desktop Relay",
                r#"{"env":{"ANTHROPIC_BASE_URL":"https://desktop.example.test","ANTHROPIC_AUTH_TOKEN":"sk-desktop"}}"#,
                r#"{"claudeDesktopMode":"direct","apiFormat":"anthropic","claudeDesktopModelRoutes":{"claude-sonnet-4-5":{"model":"claude-sonnet-4-5"}}}"#,
            );
            insert(
                "desktop-openai",
                "claude-desktop",
                "Desktop OpenAI Proxy",
                r#"{"env":{"ANTHROPIC_BASE_URL":"https://openai.example.test/v1","ANTHROPIC_AUTH_TOKEN":"sk-openai"}}"#,
                r#"{"claudeDesktopMode":"proxy","apiFormat":"openai_chat","claudeDesktopModelRoutes":{"claude-sonnet-4-5":{"model":"gpt-5.2"}}}"#,
            );
        }

        let providers =
            list_ccswitch_liveagent_providers_from_db(&db_path).expect("query providers");
        let ids: Vec<&str> = providers
            .iter()
            .map(|item| item.source_id.as_str())
            .collect();
        assert!(ids.contains(&"cli-1"), "claude CLI row should import");
        assert!(
            ids.contains(&"desktop-direct"),
            "claude desktop direct row should import"
        );
        assert!(
            !ids.contains(&"desktop-openai"),
            "non-anthropic desktop upstream should be skipped"
        );

        let desktop = providers
            .iter()
            .find(|item| item.source_id == "desktop-direct")
            .expect("desktop provider present");
        assert_eq!(desktop.provider_type, "claude_code");
        assert_eq!(desktop.base_url, "https://desktop.example.test");
        assert_eq!(desktop.api_key, "sk-desktop");
        assert_eq!(desktop.models, vec!["claude-sonnet-4-5"]);
    }

    #[test]
    fn ccs_db_query_tolerates_missing_meta_column() {
        // The old ccswitch v0 database has no meta column; ReactorPro opens it read-only and does
        // not migrate, so the query should degrade to an empty meta rather than failing outright.
        let dir = tempfile::tempdir().expect("tempdir");
        let db_path = dir.path().join("cc-switch.db");
        {
            let conn = Connection::open(&db_path).expect("create ccswitch db");
            conn.execute_batch(
                "CREATE TABLE providers (
                   id TEXT NOT NULL,
                   app_type TEXT NOT NULL,
                   name TEXT NOT NULL,
                   settings_config TEXT NOT NULL,
                   sort_index INTEGER,
                   created_at INTEGER,
                   PRIMARY KEY (id, app_type)
                 );",
            )
            .expect("create legacy providers table");
            conn.execute(
                "INSERT INTO providers (id, app_type, name, settings_config, created_at)
                 VALUES ('cli-legacy', 'claude', 'Legacy CLI',
                         '{\"env\":{\"ANTHROPIC_BASE_URL\":\"https://legacy.example.test\",\"ANTHROPIC_AUTH_TOKEN\":\"sk-legacy\"}}', 1)",
                [],
            )
            .expect("insert legacy provider row");
        }

        let providers =
            list_ccswitch_liveagent_providers_from_db(&db_path).expect("query legacy providers");
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].source_id, "cli-legacy");
        assert_eq!(providers[0].provider_type, "claude_code");
        assert_eq!(providers[0].base_url, "https://legacy.example.test");
    }

    // ===== Config backup: collect / validate / apply =====

    fn sample_backup_document() -> String {
        let snapshot = BackupSnapshot {
            providers: Some(json!([{ "id": "p-1", "name": "P1", "apiKey": "sk-plain" }])),
            mcp: Some(json!({ "servers": [{ "id": "s-1" }], "selected": ["s-1"] })),
            system: Some(json!({ "executionMode": "tools" })),
            agents: Some(json!([
                { "id": "t-1", "name": "T1", "prompt": "prompt", "enabled": true }
            ])),
            model_failover: Some(json!({ "claude_code": { "queue": ["p-1"] } })),
        };
        let manifest = build_backup_manifest(&snapshot);
        serialize_backup_document(&snapshot, &manifest).expect("serialize document")
    }

    #[test]
    fn backup_document_round_trips_all_domains() {
        let raw = sample_backup_document();
        let (snapshot, manifest) = parse_backup_document(&raw).expect("parse document");

        assert_eq!(manifest.protocol_version, BACKUP_PROTOCOL_VERSION);
        assert_eq!(manifest.schema_version, BACKUP_SCHEMA_VERSION);
        assert_eq!(manifest.encryption, "none");
        // Counts are for the UI summary: mcp counts server entries.
        assert_eq!(manifest.domains.providers, 1);
        assert_eq!(manifest.domains.mcp, 1);
        assert_eq!(manifest.domains.agents, 1);
        assert_eq!(manifest.domains.model_failover, 1);
        assert_eq!(
            snapshot.model_failover,
            Some(json!({ "claude_code": { "queue": ["p-1"] } }))
        );
        assert!(snapshot.agents.is_some());
    }

    #[test]
    fn parse_backup_document_ignores_v1_skills_and_survives_device_local_system() {
        // A v1 backup carries a skills domain and device-local keys inside system; when parsing v2,
        // skills is ignored by serde and device-local keys are whitelist-filtered on the apply side
        // (see the merge test).
        let mut document: Value =
            serde_json::from_str(&sample_backup_document()).expect("parse json");
        document["_manifest"]["schemaVersion"] = json!(1);
        document["skills"] = json!({ "enabled": true, "selected": ["skill-a"] });
        document["system"]["workdir"] = json!("/home/alice/code");

        let (snapshot, manifest) =
            parse_backup_document(&document.to_string()).expect("v1 document must parse");
        assert_eq!(manifest.schema_version, 1);
        // skills is no longer a snapshot field and must not reappear after serialization.
        let reserialized = serde_json::to_string(&snapshot).expect("serialize snapshot");
        assert!(!reserialized.contains("skill-a"), "the skills domain should be ignored");
    }

    #[test]
    fn parse_backup_document_rejects_future_versions() {
        // A higher version must be rejected rather than writing the unreadable domain as an
        // "empty config" and silently wiping the database.
        for field in ["protocolVersion", "schemaVersion"] {
            let mut document: Value =
                serde_json::from_str(&sample_backup_document()).expect("parse json");
            document["_manifest"][field] = json!(99);
            let err = parse_backup_document(&document.to_string())
                .expect_err("future version must be rejected");
            assert!(err.contains("99"), "the error message should contain the version number: {err}");
        }
    }

    #[test]
    fn parse_backup_document_rejects_unknown_encryption() {
        let mut document: Value =
            serde_json::from_str(&sample_backup_document()).expect("parse json");
        document["_manifest"]["encryption"] = json!("aes-256-gcm");

        let err = parse_backup_document(&document.to_string())
            .expect_err("unknown encryption must be rejected");
        assert!(err.contains("aes-256-gcm"), "the error message should contain the encryption method: {err}");
    }

    #[test]
    fn parse_backup_document_rejects_missing_manifest_and_malformed_domains() {
        // Missing manifest: it may just be an arbitrary JSON file, not a backup we exported.
        let err = parse_backup_document(r#"{"providers": []}"#).expect_err("manifest required");
        assert!(err.contains("missing metadata"), "it should report missing metadata: {err}");

        // Wrong domain structure: providers must be an array.
        let mut document: Value =
            serde_json::from_str(&sample_backup_document()).expect("parse json");
        document["providers"] = json!({ "not": "an array" });
        let err =
            parse_backup_document(&document.to_string()).expect_err("providers must be an array");
        assert!(err.contains("providers"), "it should point out the failing domain: {err}");
    }

    #[test]
    fn backup_snapshot_excludes_device_level_sync_config() {
        // Sync config (WebDAV address/credentials) is device-level; letting it flow
        // with the snapshot would let machine A's credentials overwrite machine B's.
        // It is deliberately kept in a separate table, so collection naturally cannot see it.
        //
        // This assertion is only meaningful when the database **actually holds** a
        // credential and the snapshot itself is non-empty: collecting against an
        // empty DB would of course find no password, and the test would still pass
        // even if the field really were included.
        let conn = open_memory_db();
        let credentials = BackupSyncConfig {
            url: "https://dav.example.com/dav/".to_string(),
            username: "sentinel-user@example.com".to_string(),
            password: "sentinel-password-must-not-leak".to_string(),
            remote_dir: "liveagent".to_string(),
            profile: "default".to_string(),
            auto_sync: true,
            last_sync_at: Some(1_700_000_000_000),
            last_error: Some("sentinel-error".to_string()),
        };
        persist_backup_sync_config(&conn, &credentials).expect("persist sync config");
        // Precondition self-check: the credential really did enter the database,
        // otherwise the assertions below become vacuous again.
        assert_eq!(
            load_backup_sync_config(&conn)
                .expect("reload sync config")
                .password,
            "sentinel-password-must-not-leak"
        );

        let mut conn = conn;
        save_providers(&mut conn, json!([{ "id": "p-1", "name": "P1" }])).expect("seed providers");
        save_mcp(&mut conn, json!({ "servers": [], "selected": [] })).expect("seed mcp");

        let snapshot = collect_backup_snapshot(&conn).expect("collect snapshot");
        let serialized = serde_json::to_string(&snapshot).expect("serialize snapshot");
        assert!(snapshot.providers.is_some(), "precondition: the snapshot is non-empty");

        assert!(!serialized.contains("backupSync"), "the snapshot should not contain sync config");
        for leaked in [
            "sentinel-password-must-not-leak",
            "sentinel-user@example.com",
            "dav.example.com",
            "sentinel-error",
        ] {
            assert!(
                !serialized.contains(leaked),
                "the snapshot leaked the device-level sync config field {leaked}: {serialized}"
            );
        }
    }

    #[test]
    fn collect_backup_snapshot_keeps_only_portable_system_keys() {
        // In the system domain, workdir / workspace paths / system proxy are device-local state:
        // absolute paths do not exist on another machine, and leaking a proxy password in plaintext
        // is meaningless anyway.
        let mut conn = open_memory_db();
        save_system_with_default_workdir(
            &mut conn,
            json!({
                "executionMode": "tools",
                "commandSafetyMode": "ask",
                "toolPolicies": { "Bash": "ask" },
                "workdir": "/home/alice/secret-project",
                "systemProxy": {
                    "enabled": true,
                    "type": "http",
                    "host": "127.0.0.1",
                    "port": 7890,
                    "username": "proxy-user",
                    "password": "proxy-sentinel-password"
                }
            }),
            "/home/alice/secret-project",
        )
        .expect("seed system");

        let snapshot = collect_backup_snapshot(&conn).expect("collect snapshot");
        let serialized = serde_json::to_string(&snapshot).expect("serialize snapshot");
        let system = snapshot.system.expect("system domain present");
        let system = system.as_object().expect("system is object");

        assert_eq!(system.get("executionMode"), Some(&json!("tools")));
        assert_eq!(system.get("commandSafetyMode"), Some(&json!("ask")));
        assert_eq!(system.get("toolPolicies"), Some(&json!({ "Bash": "ask" })));
        for device_local in [
            "workdir",
            "systemProxy",
            "workspaceProjects",
            "workspaceProjectGroups",
            "activeWorkspaceProjectId",
            "hiddenWorkspaceProjectPaths",
            "missingWorkspaceProjectPaths",
            "archivedWorkspaceProjectPaths",
            "workspaceResourceSettings",
        ] {
            assert!(
                !system.contains_key(device_local),
                "device-local key {device_local} should not enter the snapshot"
            );
        }
        assert!(
            !serialized.contains("proxy-sentinel-password"),
            "the proxy password must not enter the snapshot"
        );
        assert!(
            !serialized.contains("secret-project"),
            "local paths must not enter the snapshot"
        );
    }

    #[test]
    fn merge_portable_system_overlays_whitelist_and_preserves_device_local_values() {
        // When applying a snapshot, system uses "portable-key overlay": executionMode and
        // the like from the snapshot overwrite the local values, while workdir / proxy keep
        // their local values; device-local keys mixed into a v1 snapshot are discarded.
        let mut conn = open_memory_db();
        save_system_with_default_workdir(
            &mut conn,
            json!({
                "executionMode": "tools",
                "commandSafetyMode": "auto",
                "workdir": "/local/workdir",
                "systemProxy": {
                    "enabled": true,
                    "type": "http",
                    "host": "127.0.0.1",
                    "port": 7890,
                    "username": "",
                    "password": "local-proxy-password"
                }
            }),
            "/local/workdir",
        )
        .expect("seed local system");

        let snapshot_system = json!({
            "executionMode": "chat",
            "commandSafetyMode": "ask",
            // A v1 snapshot may carry device-local keys, which must be ignored rather than
            // overwrite the local values.
            "workdir": "/remote/other-device",
            "systemProxy": { "enabled": false }
        });
        let merged = merge_portable_system(&conn, &snapshot_system).expect("merge");
        save_system_with_default_workdir(&mut conn, merged, "/local/workdir")
            .expect("apply merged system");

        let system = load_system(&conn)
            .expect("load system")
            .expect("system present");
        assert_eq!(system["executionMode"], json!("chat"), "portable keys should be overwritten");
        assert_eq!(system["commandSafetyMode"], json!("ask"));
        assert_eq!(system["workdir"], json!("/local/workdir"), "workdir keeps its local value");
        assert_eq!(
            system["systemProxy"]["password"],
            json!("local-proxy-password"),
            "the local proxy config is unaffected by the snapshot"
        );
        assert_eq!(system["systemProxy"]["enabled"], json!(true));
    }

    #[test]
    fn normalize_sync_config_strips_dot_segments() {
        // `..` is not in `join_url`'s percent-encode set and would stay verbatim in the URL path,
        // where the server resolves it to the parent directory, letting requests escape outside the
        // WebDAV root.
        let normalized = normalize_backup_sync_config(BackupSyncConfig {
            remote_dir: "../../etc".to_string(),
            profile: "a/../../b".to_string(),
            ..BackupSyncConfig::default()
        });
        assert_eq!(normalized.remote_dir, "etc");
        assert_eq!(normalized.profile, "a/b");

        // When everything is stripped, fall back to the default rather than leaving it empty and
        // building a malformed URL.
        let emptied = normalize_backup_sync_config(BackupSyncConfig {
            remote_dir: "..".to_string(),
            profile: "./.".to_string(),
            ..BackupSyncConfig::default()
        });
        assert_eq!(emptied.remote_dir, WEBDAV_DEFAULT_REMOTE_DIR);
        assert_eq!(emptied.profile, WEBDAV_DEFAULT_PROFILE);
    }

    #[test]
    fn apply_backup_snapshot_to_db_overwrites_all_domains() {
        let mut conn = open_memory_db();
        save_providers(&mut conn, json!([{ "id": "stale", "name": "Stale" }]))
            .expect("seed providers");
        save_agents(
            &mut conn,
            json!([{ "id": "stale-t", "name": "Stale", "prompt": "old" }]),
        )
        .expect("seed agents");

        let snapshot = BackupSnapshot {
            providers: Some(json!([{ "id": "p-1", "name": "P1" }])),
            mcp: Some(json!({ "servers": [{ "id": "s-1" }], "selected": ["s-1"] })),
            system: None,
            agents: Some(json!([
                { "id": "t-1", "name": "T1", "prompt": "prompt", "enabled": true }
            ])),
            model_failover: Some(json!({ "claude_code": { "queue": ["p-1"] } })),
        };
        apply_backup_snapshot_to_db(&mut conn, &snapshot).expect("apply snapshot");

        // Whole-domain overwrite: the importing side's pre-existing stale providers / templates
        // must disappear.
        assert_eq!(
            load_providers(&conn).expect("load providers"),
            Some(json!([{ "id": "p-1", "name": "P1" }]))
        );
        let mcp = load_mcp(&conn).expect("load mcp").expect("mcp present");
        assert_eq!(mcp["selected"], json!(["s-1"]));
        let agents = load_agents(&conn)
            .expect("load agents")
            .expect("agents present");
        assert_eq!(agents[0]["id"], json!("t-1"), "the old template should be overwritten by the whole-domain overwrite");
        assert_eq!(
            load_model_failover(&conn).expect("load model failover"),
            Some(json!({ "claude_code": { "queue": ["p-1"] } }))
        );
    }

    #[test]
    fn apply_backup_snapshot_to_db_leaves_config_intact_when_domain_absent() {
        // A domain being None means the exporting side had no such config and must not be treated
        // as "clear it".
        let mut conn = open_memory_db();
        save_providers(&mut conn, json!([{ "id": "keep", "name": "Keep" }]))
            .expect("seed providers");

        apply_backup_snapshot_to_db(&mut conn, &BackupSnapshot::default()).expect("apply empty");

        assert_eq!(
            load_providers(&conn).expect("load providers"),
            Some(json!([{ "id": "keep", "name": "Keep" }]))
        );
    }

    #[test]
    fn apply_backup_snapshot_remaps_provider_ids_to_local_identity() {
        // When two devices each "added" the same provider, their UUIDs necessarily differ. If the
        // import keeps the source id verbatim, every {customProviderId} stored in local sessions /
        // default models / memory / scheduled tasks fails to match and is silently cleared during
        // normalization.
        let mut conn = open_memory_db();
        save_providers(
            &mut conn,
            json!([
                {
                    "id": "local-uuid-claude",
                    "type": "claude_code",
                    "baseUrl": "",
                    "name": "Claude",
                    "apiKey": "sk-local-old"
                },
                { "id": "builtin-codex", "type": "codex", "baseUrl": "", "name": "Codex" }
            ]),
        )
        .expect("seed local providers");

        let snapshot = BackupSnapshot {
            providers: Some(json!([
                // Same identity (type+baseUrl+name), different id → rewrite to the local id.
                {
                    "id": "source-uuid-claude",
                    "type": "claude_code",
                    "baseUrl": "",
                    "name": "Claude",
                    "apiKey": "sk-source-new"
                },
                // Same id (built-in slot) → keep as-is.
                { "id": "builtin-codex", "type": "codex", "baseUrl": "", "name": "Codex" },
                // A new provider that does not exist locally → keep the source id.
                {
                    "id": "source-uuid-fresh",
                    "type": "openai_compatible",
                    "baseUrl": "https://fresh.example.com/v1",
                    "name": "Fresh"
                }
            ])),
            model_failover: Some(json!({
                "claude_code": { "queue": ["source-uuid-claude", "source-uuid-fresh"] }
            })),
            ..Default::default()
        };
        apply_backup_snapshot_to_db(&mut conn, &snapshot).expect("apply snapshot");

        let providers = load_providers(&conn)
            .expect("load providers")
            .expect("providers present");
        let ids: Vec<&str> = providers
            .as_array()
            .expect("providers array")
            .iter()
            .map(|provider| provider["id"].as_str().expect("provider id"))
            .collect();
        assert_eq!(
            ids,
            vec!["local-uuid-claude", "builtin-codex", "source-uuid-fresh"],
            "providers with the same identity should keep the local id; the rest stay unchanged"
        );
        // The id stays local while the content follows the backup.
        assert_eq!(providers[0]["apiKey"], json!("sk-source-new"));
        // The failover queue is rewritten together with providers so cross-domain references stay
        // consistent.
        assert_eq!(
            load_model_failover(&conn).expect("load model failover"),
            Some(json!({
                "claude_code": { "queue": ["local-uuid-claude", "source-uuid-fresh"] }
            }))
        );
    }

    #[test]
    fn provider_id_map_matches_by_endpoint_and_refuses_ambiguity() {
        let as_array = |value: &Value| value.as_array().expect("array").clone();

        // Level 3: only the display name changed; type+baseUrl (with trailing-slash normalization)
        // being unique on both sides is enough to pair them.
        let incoming = json!([
            {
                "id": "source-a",
                "type": "openai_compatible",
                "baseUrl": "https://api.example.com/v1",
                "name": "After rename"
            }
        ]);
        let local = json!([
            {
                "id": "local-a",
                "type": "openai_compatible",
                "baseUrl": "https://api.example.com/v1/",
                "name": "Old name"
            }
        ]);
        let id_map = build_provider_id_map(&as_array(&incoming), &as_array(&local));
        assert_eq!(id_map.get("source-a"), Some(&"local-a".to_string()));

        // When two local candidates share an endpoint (multiple accounts) they are
        // indistinguishable; better to pair none than to pair wrongly.
        let ambiguous_local = json!([
            {
                "id": "local-1",
                "type": "openai_compatible",
                "baseUrl": "https://api.example.com/v1",
                "name": "Account one"
            },
            {
                "id": "local-2",
                "type": "openai_compatible",
                "baseUrl": "https://api.example.com/v1",
                "name": "Account two"
            }
        ]);
        let id_map = build_provider_id_map(&as_array(&incoming), &as_array(&ambiguous_local));
        assert!(id_map.is_empty(), "ambiguous candidates must not be paired: {id_map:?}");

        // Entries missing type do not participate in identity pairing, avoiding mistaking
        // coincidentally same-named configs for the same one.
        let untyped_incoming = json!([{ "id": "source-x", "name": "Same name" }]);
        let untyped_local = json!([{ "id": "local-x", "name": "Same name" }]);
        let id_map =
            build_provider_id_map(&as_array(&untyped_incoming), &as_array(&untyped_local));
        assert!(id_map.is_empty(), "entries missing type must not be paired: {id_map:?}");
    }

    #[test]
    fn provider_id_rewrite_updates_legacy_failover_queue_entries() {
        // The legacy failover queue stores { customProviderId, model } objects; the rewrite must
        // stay compatible.
        let mut snapshot = BackupSnapshot {
            providers: Some(json!([
                { "id": "source-a", "type": "claude_code", "baseUrl": "", "name": "Claude" }
            ])),
            model_failover: Some(json!({
                "claude_code": {
                    "queue": [
                        { "customProviderId": "source-a", "model": "claude-4.6" },
                        "unrelated-id"
                    ]
                }
            })),
            ..Default::default()
        };
        let id_map = HashMap::from([("source-a".to_string(), "local-a".to_string())]);
        rewrite_snapshot_provider_ids(&mut snapshot, &id_map);

        assert_eq!(
            snapshot.providers,
            Some(json!([
                { "id": "local-a", "type": "claude_code", "baseUrl": "", "name": "Claude" }
            ]))
        );
        assert_eq!(
            snapshot.model_failover,
            Some(json!({
                "claude_code": {
                    "queue": [
                        { "customProviderId": "local-a", "model": "claude-4.6" },
                        "unrelated-id"
                    ]
                }
            }))
        );
    }

    #[test]
    fn validate_backup_snapshot_rejects_malformed_domains() {
        let cases = [
            (
                BackupSnapshot {
                    providers: Some(json!({})),
                    ..Default::default()
                },
                "providers",
            ),
            (
                BackupSnapshot {
                    mcp: Some(json!({ "servers": "nope" })),
                    ..Default::default()
                },
                "mcp.servers",
            ),
            (
                BackupSnapshot {
                    system: Some(json!([])),
                    ..Default::default()
                },
                "system",
            ),
            (
                BackupSnapshot {
                    agents: Some(json!({})),
                    ..Default::default()
                },
                "agents",
            ),
            (
                BackupSnapshot {
                    model_failover: Some(json!([])),
                    ..Default::default()
                },
                "modelFailover",
            ),
        ];

        for (snapshot, expected) in cases {
            let err =
                validate_backup_snapshot(&snapshot).expect_err("malformed domain must be rejected");
            assert!(err.contains(expected), "the error message should contain {expected}: {err}");
        }
    }

    // ===== WebDAV sync: config parsing / remote paths / integrity verification =====

    fn sample_sync_config() -> BackupSyncConfig {
        BackupSyncConfig {
            url: "https://dav.example.com/dav".to_string(),
            username: "alice".to_string(),
            password: "stored-secret".to_string(),
            remote_dir: "liveagent".to_string(),
            profile: "work".to_string(),
            auto_sync: false,
            last_sync_at: Some(1_700_000_000_000),
            last_error: None,
        }
    }

    fn sync_request(password: &str, password_touched: bool) -> BackupSyncConfigRequest {
        BackupSyncConfigRequest {
            url: "https://dav.example.com/dav".to_string(),
            username: "alice".to_string(),
            password: password.to_string(),
            password_touched,
            remote_dir: "liveagent".to_string(),
            profile: "work".to_string(),
            auto_sync: true,
        }
    }

    #[test]
    fn sync_config_keeps_stored_password_when_untouched() {
        let persisted = sample_sync_config();
        // The UI fills the password field with a masked placeholder; if the user leaves it alone it
        // must not be written to the database as a new password.
        let resolved = resolve_backup_sync_config(sync_request("••••••••", false), &persisted);
        assert_eq!(resolved.password, "stored-secret");
        assert!(resolved.auto_sync);
        // Saving the config should not change the sync time.
        assert_eq!(resolved.last_sync_at, persisted.last_sync_at);
    }

    #[test]
    fn sync_config_takes_new_password_when_touched() {
        let persisted = sample_sync_config();
        let resolved = resolve_backup_sync_config(sync_request("fresh-secret", true), &persisted);
        assert_eq!(resolved.password, "fresh-secret");
    }

    #[test]
    fn sync_config_clearing_password_is_honored() {
        let persisted = sample_sync_config();
        // The user deliberately cleared the password field — it must really be cleared and must not
        // fall back to the old value, otherwise the account cannot be switched.
        let resolved = resolve_backup_sync_config(sync_request("", true), &persisted);
        assert!(resolved.password.is_empty());
    }

    /// Saving the config must clear a leftover auto-sync error.
    ///
    /// That error describes the config state **before** the change; if it kept showing in the UI,
    /// the user would think the newly entered address is also broken and keep fussing over an
    /// already-fixed problem.
    #[test]
    fn sync_config_save_clears_stale_auto_sync_error() {
        let mut persisted = sample_sync_config();
        persisted.last_error = Some("Authentication failed (401): check the username and password".to_string());

        let resolved = resolve_backup_sync_config(sync_request("fresh-secret", true), &persisted);
        assert!(resolved.last_error.is_none(), "no stale error should remain after saving");
        // The sync time is an established fact and must not be cleared along with it.
        assert_eq!(resolved.last_sync_at, persisted.last_sync_at);
    }

    #[test]
    fn sync_config_normalizes_paths_and_falls_back_to_defaults() {
        let persisted = BackupSyncConfig::default();
        let mut request = sync_request("x", true);
        request.url = "  https://dav.example.com/dav/  ".to_string();
        request.remote_dir = "  /backups/  ".to_string();
        request.profile = "   ".to_string();

        let resolved = resolve_backup_sync_config(request, &persisted);
        assert_eq!(resolved.url, "https://dav.example.com/dav");
        assert_eq!(resolved.remote_dir, "backups");
        // An empty profile falls back to the default, otherwise the remote path would contain an
        // empty segment.
        assert_eq!(resolved.profile, "default");
    }

    #[test]
    fn remote_segments_are_versioned_and_profile_scoped() {
        let config = sample_sync_config();
        assert_eq!(
            backup_remote_segments(&config),
            vec!["liveagent", "v1", "work"]
        );
        assert_eq!(
            backup_remote_file_segments(&config, "config.json"),
            vec!["liveagent", "v1", "work", "config.json"]
        );
        // Different profiles must land in different remote directories, otherwise the two configs
        // would overwrite each other.
        let mut other = sample_sync_config();
        other.profile = "personal".to_string();
        assert_ne!(
            backup_remote_segments(&config),
            backup_remote_segments(&other)
        );
    }

    #[test]
    fn verify_payload_accepts_matching_size_and_hash() {
        let body = b"{\"providers\":[]}";
        let sha = backup_sha256_hex(body);
        assert!(verify_backup_payload(body, body.len(), &sha).is_ok());
    }

    #[test]
    fn verify_payload_rejects_truncated_or_corrupted_body() {
        let body = b"{\"providers\":[]}";
        let sha = backup_sha256_hex(body);

        // A truncated file left by an interrupted PUT.
        let truncated = verify_backup_payload(body, body.len() + 8, &sha)
            .expect_err("size mismatch must be rejected");
        assert!(truncated.contains("size check failed"), "{truncated}");

        let corrupted = verify_backup_payload(body, body.len(), &"0".repeat(64))
            .expect_err("hash mismatch must be rejected");
        assert!(corrupted.contains("checksum mismatch"), "{corrupted}");
    }

    #[test]
    fn verify_payload_rejects_manifest_without_size_or_hash() {
        // A missing size/sha256 must not be allowed through as "no verification needed". The `v1/`
        // layout was introduced together with this feature, no historical version ever wrote a
        // manifest without a digest, and only abnormal data reaches here.
        let err = verify_backup_payload(b"anything", 0, "")
            .expect_err("manifest without size/sha256 must be rejected");
        assert!(err.contains("missing a size or checksum"), "{err}");

        assert!(verify_backup_payload(b"anything", 8, "").is_err());
        assert!(verify_backup_payload(b"anything", 0, "abc").is_err());
    }

    #[test]
    fn remote_manifest_carries_size_and_hash_and_validates_version() {
        let snapshot = BackupSnapshot {
            providers: Some(json!([{ "id": "p-1" }])),
            ..Default::default()
        };
        let manifest = build_backup_manifest(&snapshot);
        let body = json!({
            "protocolVersion": manifest.protocol_version,
            "schemaVersion": manifest.schema_version,
            "snapshotId": manifest.snapshot_id,
            "createdAt": manifest.created_at,
            "deviceName": "box-a",
            "appVersion": manifest.app_version,
            "encryption": "none",
            "domains": { "providers": 1, "mcp": 0, "system": 0, "skills": 0 },
            "size": 42,
            "sha256": "abc123",
        })
        .to_string();

        let parsed = parse_backup_remote_manifest(body.as_bytes()).expect("parse remote manifest");
        assert_eq!(parsed.size, 42);
        assert_eq!(parsed.sha256, "abc123");
        assert_eq!(parsed.manifest.device_name, "box-a");
    }

    #[test]
    fn remote_manifest_rejects_future_protocol_version() {
        let body = json!({
            "protocolVersion": 99,
            "schemaVersion": 1,
            "snapshotId": "s-1",
            "createdAt": "2026-08-17T00:00:00Z",
            "deviceName": "box-a",
            "appVersion": "1.0.0",
            "encryption": "none",
            "size": 1,
            "sha256": "ab",
        })
        .to_string();

        let err = parse_backup_remote_manifest(body.as_bytes())
            .expect_err("future protocol version must be rejected");
        assert!(err.contains("upgrade the app"), "{err}");
    }

    #[test]
    fn sync_config_view_never_exposes_password() {
        let view: BackupSyncConfigView = sample_sync_config().into();
        let serialized = serde_json::to_string(&view).expect("serialize view");
        assert!(!serialized.contains("stored-secret"), "{serialized}");
        assert!(!serialized.contains("password\":"), "{serialized}");
        assert!(view.has_password);

        let empty = BackupSyncConfigView::from(BackupSyncConfig::default());
        assert!(!empty.has_password);
    }

    /// `last_error` must survive the round trip of "serialize to the DB → deserialize back".
    ///
    /// It is the only trace of an auto-sync failure after the page unloads; losing it during
    /// serialization means it was never recorded.
    #[test]
    fn sync_config_persists_auto_sync_error_across_serialization() {
        let mut config = sample_sync_config();
        config.last_error = Some("Insufficient remote storage space".to_string());

        let json = serde_json::to_string(&config).expect("serialize config");
        let restored: BackupSyncConfig = serde_json::from_str(&json).expect("deserialize config");
        assert_eq!(restored.last_error.as_deref(), Some("Insufficient remote storage space"));

        // Records written by older versions lack this field; reading them back must fall back to
        // None rather than fail to parse.
        let legacy = r#"{"url":"https://dav.example.com/dav","username":"alice",
            "password":"s","remoteDir":"liveagent","profile":"work","autoSync":true}"#;
        let parsed: BackupSyncConfig = serde_json::from_str(legacy).expect("parse legacy payload");
        assert!(parsed.last_error.is_none());
        assert!(parsed.last_sync_at.is_none());

        // The error must be delivered to the frontend with the view, otherwise the UI still cannot
        // see it.
        let view: BackupSyncConfigView = config.into();
        assert_eq!(view.last_error.as_deref(), Some("Insufficient remote storage space"));
    }

    /// A "two devices" round trip against a real server. **Not run by default** (`#[ignore]`).
    ///
    /// ```text
    /// LIVEAGENT_WEBDAV_URL=... LIVEAGENT_WEBDAV_USER=... LIVEAGENT_WEBDAV_PASS=... \
    /// cargo test --lib settings::tests::live -- --ignored --nocapture
    /// ```
    ///
    /// Why not call `settings_backup_upload` / `settings_backup_download` directly:
    /// those two commands read and write the real `~/.liveagent/config.sqlite`, and running tests
    /// would modify the developer's own config. Here, two in-memory databases play devices A / B,
    /// reusing the same collection, serialization, manifest construction and verification
    /// functions, while the network part goes entirely through the real `services::webdav`.
    /// So what is covered is AC7 (cross-device consistency) and AC9 (checksum gatekeeping), not
    /// the command shell.
    #[tokio::test]
    #[ignore = "requires a real WebDAV account, provided via LIVEAGENT_WEBDAV_* environment variables"]
    async fn live_cross_device_snapshot_round_trip() {
        let (Ok(url), Ok(username), Ok(password)) = (
            std::env::var("LIVEAGENT_WEBDAV_URL"),
            std::env::var("LIVEAGENT_WEBDAV_USER"),
            std::env::var("LIVEAGENT_WEBDAV_PASS"),
        ) else {
            eprintln!("skipping: LIVEAGENT_WEBDAV_URL / _USER / _PASS are not set");
            return;
        };

        let config = BackupSyncConfig {
            url,
            username,
            password,
            remote_dir: format!("liveagent-livetest-{}", std::process::id()),
            profile: "default".to_string(),
            auto_sync: false,
            last_sync_at: None,
            last_error: None,
        };
        let creds = backup_credentials(&config).expect("credentials");

        // —— Device A: collect and upload ——
        let mut device_a = open_memory_db();
        save_providers(
            &mut device_a,
            json!([{ "id": "p-live", "name": "Live Provider", "apiKey": "sk-live-probe" }]),
        )
        .expect("seed providers on device A");
        save_mcp(
            &mut device_a,
            json!({ "servers": [{ "id": "s-live" }], "selected": ["s-live"] }),
        )
        .expect("seed mcp on device A");

        save_agents(
            &mut device_a,
            json!([{ "id": "t-live", "name": "Live template", "prompt": "live prompt" }]),
        )
        .expect("seed agents on device A");

        let snapshot = collect_backup_snapshot(&device_a).expect("collect snapshot");
        let manifest = build_backup_manifest(&snapshot);
        let document = serialize_backup_document(&snapshot, &manifest).expect("serialize");
        let body = document.into_bytes();

        let remote_manifest_body = serde_json::to_vec_pretty(&json!({
            "protocolVersion": manifest.protocol_version,
            "schemaVersion": manifest.schema_version,
            "snapshotId": manifest.snapshot_id,
            "createdAt": manifest.created_at,
            "deviceName": manifest.device_name,
            "appVersion": manifest.app_version,
            "encryption": "none",
            "domains": {
                "providers": 1, "mcp": 1, "system": 0,
                "agents": 1, "modelFailover": 0,
            },
            "size": body.len(),
            "sha256": backup_sha256_hex(&body),
        }))
        .expect("serialize remote manifest");

        crate::services::webdav::ensure_remote_dirs(&creds, &backup_remote_segments(&config))
            .await
            .expect("ensure remote dirs");
        // Same order as production: config first, then manifest.
        crate::services::webdav::put_bytes(
            &creds,
            &backup_remote_file_segments(&config, WEBDAV_CONFIG_FILENAME),
            body.clone(),
            "application/json",
        )
        .await
        .expect("put config.json");
        crate::services::webdav::put_bytes(
            &creds,
            &backup_remote_file_segments(&config, WEBDAV_MANIFEST_FILENAME),
            remote_manifest_body,
            "application/json",
        )
        .await
        .expect("put manifest.json");
        eprintln!("upload complete: config {} bytes", body.len());

        // —— Device B: fetch manifest → fetch config → verify → apply ——
        let manifest_bytes = crate::services::webdav::get_bytes(
            &creds,
            &backup_remote_file_segments(&config, WEBDAV_MANIFEST_FILENAME),
            WEBDAV_MANIFEST_MAX_BYTES,
            "remote backup metadata",
        )
        .await
        .expect("get manifest")
        .expect("manifest must exist");
        let remote = parse_backup_remote_manifest(&manifest_bytes).expect("parse remote manifest");
        eprintln!(
            "remote manifest: device {} / {} bytes",
            remote.manifest.device_name, remote.size
        );

        let config_bytes = crate::services::webdav::get_bytes(
            &creds,
            &backup_remote_file_segments(&config, WEBDAV_CONFIG_FILENAME),
            WEBDAV_CONFIG_MAX_BYTES,
            "remote config",
        )
        .await
        .expect("get config")
        .expect("config must exist");

        // AC9 positive: after a real server round trip the checksum must still match.
        verify_backup_payload(&config_bytes, remote.size, &remote.sha256)
            .expect("checksum should match after a real round trip");
        eprintln!("verification passed: sha256 {}", &remote.sha256[..16]);

        // AC9 negative: tampering with a single byte must be caught.
        let mut tampered = config_bytes.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        let err = verify_backup_payload(&tampered, remote.size, &remote.sha256)
            .expect_err("verification must fail after tampering");
        assert!(err.contains("checksum mismatch"), "{err}");

        // AC7: apply to device B; each domain should match device A.
        let text = String::from_utf8(config_bytes).expect("utf-8 config");
        let (parsed_snapshot, _) = parse_backup_document(&text).expect("parse document");
        let mut device_b = open_memory_db();
        save_providers(&mut device_b, json!([{ "id": "stale-b", "name": "Old config" }]))
            .expect("seed providers on device B");
        apply_backup_snapshot_to_db(&mut device_b, &parsed_snapshot).expect("apply on device B");

        assert_eq!(
            load_providers(&device_b).expect("load providers on B"),
            load_providers(&device_a).expect("load providers on A"),
            "device B's providers should match device A's"
        );
        assert_eq!(
            load_mcp(&device_b).expect("load mcp on B"),
            load_mcp(&device_a).expect("load mcp on A"),
            "device B's mcp should match device A's"
        );
        assert_eq!(
            load_agents(&device_b).expect("load agents on B"),
            load_agents(&device_a).expect("load agents on A"),
            "device B's prompt templates should match device A's"
        );
        // Device-level credentials must never flow with the snapshot (S2).
        assert!(
            !text.contains(&config.username),
            "the snapshot must not contain the WebDAV username"
        );
        assert!(!text.contains("backupSync"), "the snapshot must not contain sync config");
        eprintln!("device B restored consistently, and the snapshot contains no WebDAV credentials");
    }
}
