import {
  ArrowRight,
  History,
  Key,
  Lock,
  MessageSquareText,
  Shield,
  Timer,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Textarea } from "@liveagent/ui/components/ui/textarea";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useState } from "react";

type LoginPageProps = {
  token: string;
  error: string | null;
  isSubmitting: boolean;
  onTokenChange: (token: string) => void;
  onSubmit: () => void;
};

const features = [
  {
    icon: MessageSquareText,
    title: "Remote Chat",
    desc: "View token, thinking, tool_call and tool_result in the desktop style.",
    accent: "login-feat--blue",
  },
  {
    icon: History,
    title: "History Resume",
    desc: "Restore conversations from remote history and keep chatting, instead of just looking at raw JSON.",
    accent: "login-feat--violet",
  },
  {
    icon: Timer,
    title: "Cron Control",
    desc: "Forward and debug task view, create, update and delete from the browser.",
    accent: "login-feat--amber",
  },
];

export function LoginPage({ token, error, isSubmitting, onTokenChange, onSubmit }: LoginPageProps) {
  const [isFocused, setIsFocused] = useState(false);

  return (
    <main className="login-shell">
      {/* Subtle mesh gradient backdrop */}
      <div className="login-backdrop" aria-hidden="true" />
      <div className="login-backdrop-orb login-backdrop-orb--1" aria-hidden="true" />
      <div className="login-backdrop-orb login-backdrop-orb--2" aria-hidden="true" />

      <div className="login-container login-entrance">
        {/* Left: branding + features */}
        <div className="login-hero login-entrance-d1">
          <div className="login-hero-title-row">
            <div className="login-logo-mark">
              <Shield size={18} strokeWidth={2} />
            </div>
            <h1 className="login-hero-title">ReactorPro Gateway</h1>
          </div>
          <p className="login-hero-desc">
            Securely connect to remote agent sessions and get the full console experience in your
            browser.
          </p>

          <div className="login-feat-list login-entrance-d2">
            {features.map((f) => (
              <div key={f.title} className={cn("login-feat", f.accent)}>
                <div className="login-feat-icon">
                  <f.icon size={16} strokeWidth={2} />
                </div>
                <div className="login-feat-text">
                  <strong>{f.title}</strong>
                  <span>{f.desc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Right: auth form */}
        <div className="login-form-panel login-entrance-d2">
          <div className="login-form-card">
            <div className="login-form-header">
              <div className="login-form-title-row">
                <div className="login-form-icon">
                  <Lock size={16} strokeWidth={2} />
                </div>
                <h2 className="login-form-title">Connect Console</h2>
              </div>
              <p className="login-form-sub">
                Enter the Gateway server Access Token to authenticate
              </p>
            </div>

            <div className={cn("login-input-wrap", isFocused && "login-input-wrap--focus")}>
              <label htmlFor="access-token" className="login-input-label">
                <Key size={12} strokeWidth={2.5} />
                Access Token
              </label>
              <Textarea
                id="access-token"
                name="access_token"
                rows={3}
                value={token}
                placeholder=""
                disabled={isSubmitting}
                aria-invalid={error ? "true" : "false"}
                onChange={(e) => onTokenChange(e.target.value)}
                onFocus={() => setIsFocused(true)}
                onBlur={() => setIsFocused(false)}
                className="login-input"
              />
            </div>

            {error && <p className="login-form-error">{error}</p>}

            <Button
              type="button"
              size="lg"
              disabled={token.trim() === "" || isSubmitting}
              onClick={onSubmit}
              className="login-btn"
            >
              {isSubmitting ? (
                <span className="login-btn-loading" />
              ) : (
                <>
                  Enter Gateway
                  <ArrowRight size={15} strokeWidth={2.2} />
                </>
              )}
            </Button>

            <p className="login-form-footer">
              Once the token is verified it is stored locally for automatic sign-in next time
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
