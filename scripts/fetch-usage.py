# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pydoll-python",
# ]
# ///
"""
Fetch per-account Claude Code usage via claude.ai.

Uses pydoll with Chrome's existing user profile (already logged in).
Navigates to the settings/usage page and intercepts the API response.

Usage:
  uv run scripts/fetch-usage.py                  # headless
  uv run scripts/fetch-usage.py --visible         # visible browser

Writes results to ~/.ccrotate/tier-cache.json.
"""

import asyncio
import json
import os
import sys
import time
from pathlib import Path

from pydoll.browser import Chrome
from pydoll.browser.options import ChromiumOptions


PROFILES_FILE = Path.home() / ".ccrotate" / "profiles.json"
CACHE_FILE = Path.home() / ".ccrotate" / "tier-cache.json"


def load_profiles() -> dict:
    if not PROFILES_FILE.exists():
        return {}
    return json.loads(PROFILES_FILE.read_text())


def save_cache(results: list):
    cache = {
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "source": "claude.ai",
        "accounts": results,
    }
    CACHE_FILE.write_text(json.dumps(cache, indent=2))
    print(f"\n✓ Cache saved to {CACHE_FILE}")


def parse_usage(data: dict, email: str) -> dict:
    u7d = data.get("seven_day", {}).get("utilization")
    u5h = data.get("five_hour", {}).get("utilization")
    reset_at = data.get("seven_day", {}).get("resets_at")
    extra = data.get("extra_usage", {}) or {}
    used_credits = extra.get("used_credits", 0) or 0

    tier = "base"
    if u7d is not None and u7d >= 100:
        tier = "exhausted"
    elif extra.get("is_enabled") and used_credits > 0:
        tier = "extra"

    parts = []
    if u5h is not None:
        parts.append(f"5h:{round(u5h)}%")
    if u7d is not None:
        parts.append(f"7d:{round(u7d)}%")
    if used_credits > 0:
        parts.append(f"extra:${used_credits / 100:.2f}")
    display = tier + (f" ({' '.join(parts)})" if parts else "")

    return {
        "email": email,
        "status": "success",
        "serviceTier": tier,
        "response": display,
        "rateLimits": {
            "utilization5h": u5h,
            "utilization7d": u7d,
            "resetAt": reset_at,
            "extra": {
                "is_enabled": extra.get("is_enabled", False),
                "used_credits": used_credits,
                "monthly_limit": extra.get("monthly_limit"),
            },
        },
    }


async def main():
    headless = "--visible" not in sys.argv

    profiles = load_profiles()
    # Get unique org UUIDs
    orgs = {}
    for email, p in profiles.items():
        org = p.get("oauthAccount", {}).get("organizationUuid")
        if org and org not in orgs:
            orgs[org] = email  # just need one email per org for display

    print(f"🔍 Fetching usage from claude.ai (using Chrome profile)...\n")

    options = ChromiumOptions()
    options.headless = headless
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.start_timeout = 60

    chrome_path = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    if os.path.exists(chrome_path):
        options.binary_location = chrome_path

    # Use default Chrome profile (already logged in to claude.ai)
    chrome_user_data = str(Path.home() / "Library/Application Support/Google/Chrome")
    if os.path.exists(chrome_user_data):
        options.add_argument(f"--user-data-dir={chrome_user_data}")
        options.add_argument("--profile-directory=Default")

    options.browser_preferences = {
        "profile": {
            "last_engagement_time": int(time.time()) - (7 * 24 * 60 * 60),
            "exit_type": "Normal",
            "exited_cleanly": True,
        },
    }

    results = []
    usage_responses = {}

    async with Chrome(options=options) as browser:
        tab = await browser.start()

        # Set up network interception to capture usage API responses
        captured = asyncio.Event()

        async def on_response(event):
            resp = event.get("params", {}).get("response", {})
            url = resp.get("url", "")
            if "/usage" in url and "/api/organizations/" in url:
                request_id = event["params"]["requestId"]
                try:
                    body_resp = await tab.execute_cdp_command(
                        "Network.getResponseBody", {"requestId": request_id}
                    )
                    data = json.loads(body_resp.get("body", "{}"))
                    # Extract org UUID from URL
                    parts = url.split("/api/organizations/")[1].split("/")
                    org_id = parts[0]
                    usage_responses[org_id] = data
                    captured.set()
                except Exception as e:
                    print(f"  ⚠️  Could not read response: {e}")

        await tab.execute_cdp_command("Network.enable", {})
        tab.on("Network.responseReceived", on_response)

        # Navigate to usage page (Chrome already has cookies)
        print("  Navigating to claude.ai/settings/usage...")
        async with tab.expect_and_bypass_cloudflare_captcha():
            await tab.go_to("https://claude.ai/settings/usage")

        # Wait for the usage API call
        try:
            await asyncio.wait_for(captured.wait(), timeout=20)
        except asyncio.TimeoutError:
            print("  ⚠️  Timeout waiting for usage API response")

        # If we didn't capture via network, try JS fetch
        if not usage_responses:
            print("  Trying JS fetch fallback...")
            for org_id in orgs:
                data = await tab.execute_script(f"""
                    try {{
                        const resp = await fetch('/api/organizations/{org_id}/usage', {{
                            credentials: 'include',
                            headers: {{ 'accept': 'application/json' }}
                        }});
                        if (resp.ok) return await resp.json();
                        return null;
                    }} catch(e) {{ return null; }}
                """)
                if data:
                    usage_responses[org_id] = data

    # Map usage data to accounts
    for email, profile in profiles.items():
        org = profile.get("oauthAccount", {}).get("organizationUuid")
        if org and org in usage_responses:
            result = parse_usage(usage_responses[org], email)
            print(f"  ✅ {email}: {result['response']}")
        else:
            result = {
                "email": email,
                "status": "error",
                "serviceTier": None,
                "response": "No usage data",
            }
            print(f"  ❌ {email}: no data")
        results.append(result)

    if results:
        save_cache(results)

    print(f"\n{'='*60}")
    for r in results:
        icon = "✅" if r["status"] == "success" else "❌"
        print(f"  {icon} {r['email']}: {r.get('serviceTier', '-')} — {r.get('response', '')}")
    print(f"{'='*60}")


if __name__ == "__main__":
    asyncio.run(main())
