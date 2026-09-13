//! Remote mesh invocation: an agent in another organisation asking an agent on
//! this machine to do something.
//!
//! The edge forwards a request only after its inbound guard has verified the
//! caller's signature against a trusted fingerprint, and it carries that verified
//! identity down here. The desktop is therefore never asked to trust an
//! unauthenticated caller, and what it records is the identity the edge actually
//! established rather than a name the peer chose for itself.

use std::sync::Arc;

use super::*;

/// The one operation this build recognises. Kept in step with the gateway's
/// default `-mesh-invoke-operations` and the `task` arm in
/// `internal/mesh/invoke.go`.
const MESH_OPERATION_TASK: &str = "task";

/// Code reported when this desktop cannot serve the requested operation. The
/// gateway maps it to 3001 SKILL_NOT_FOUND, which is the honest answer: this
/// agent does not serve this. It is deliberately not a retryable code, because
/// waiting and asking again will not change the outcome.
const MESH_CODE_UNSUPPORTED: &str = "unsupported_operation";

impl GatewayController {
    /// Answers a remote invocation.
    ///
    /// Always replies exactly once, refusals included. A peer that receives
    /// nothing would sit out its deadline and could not tell a refusal from an
    /// outage, which is the difference between "ask someone else" and "retry".
    pub(crate) async fn handle_mesh_invoke(
        self: &Arc<Self>,
        request_id: String,
        request: proto::MeshInvokeRequest,
    ) -> Result<(), String> {
        let response = evaluate_mesh_invoke(&request);

        // Record before answering, so a refusal is still audited if the reply
        // cannot be delivered. This is the desktop's own record of who asked for
        // what; the edge keeps its own.
        if response.ok {
            eprintln!(
                "mesh invoke accepted: caller={} fingerprint={} target={} operation={} task={}",
                request.caller,
                request.caller_fingerprint,
                request.target,
                request.operation,
                request.task_id
            );
        } else {
            eprintln!(
                "mesh invoke refused: caller={} fingerprint={} target={} operation={} task={} code={}",
                request.caller,
                request.caller_fingerprint,
                request.target,
                request.operation,
                request.task_id,
                response.error_code
            );
        }

        self.send_agent_envelope(proto::AgentEnvelope {
            request_id,
            timestamp: now_unix_seconds(),
            payload: Some(proto::agent_envelope::Payload::MeshInvokeResp(response)),
        })
        .await
    }
}

/// Decides the outcome of a remote invocation.
///
/// Deliberately a free function with no access to controller state: the whole
/// decision is then readable in one place and can be tested without a live
/// gateway connection.
///
/// # Why every task is currently refused
///
/// The routing, the gates and the transport are in place, but nothing consumes
/// the work: this build has no execution surface wired for remote tasks. That is
/// a product decision, not an oversight — the plausible surfaces (injecting the
/// prompt into the human's chat session, or running headless through the chat
/// runtime) differ in whether the local user sees the request, whose provider
/// quota it spends, and what the audit record contains. Until that is chosen
/// deliberately, answering `unsupported_operation` is the honest response: it
/// tells the caller to route elsewhere instead of failing them with a generic
/// internal error.
fn evaluate_mesh_invoke(request: &proto::MeshInvokeRequest) -> proto::MeshInvokeResponse {
    let refuse = |code: &str, message: String| proto::MeshInvokeResponse {
        ok: false,
        result_json: Vec::new(),
        error_code: code.to_string(),
        error_message: message,
    };

    // A deadline already in the past means the caller has given up or its clock
    // is badly wrong. Answering anyway is still better than silence: it tells the
    // peer the routing worked and only the timing did not.
    if request.deadline_unix_ms > 0 && request.deadline_unix_ms <= now_unix_seconds() * 1000 {
        return refuse(
            "timeout",
            "the invocation deadline had already passed when the request arrived".to_string(),
        );
    }

    let operation = request.operation.trim();
    if operation != MESH_OPERATION_TASK {
        return refuse(
            MESH_CODE_UNSUPPORTED,
            format!("operation {operation:?} is not served by this desktop build"),
        );
    }

    refuse(
        MESH_CODE_UNSUPPORTED,
        "this desktop build has no execution surface wired for remote tasks yet; \
         the request was verified and routed correctly, but nothing here will run it"
            .to_string(),
    )
}
