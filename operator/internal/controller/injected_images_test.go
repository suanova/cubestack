package controller

import "testing"

// SetInjectedImages is how the operator chart re-points the two references the
// manager names for the pods it creates. Its contract matters on both sides:
// a non-empty argument replaces the build-time default (offline installs), and
// an empty one leaves it alone (online installs, local builds, the e2e) — the
// chart renders no flag in that case, so an empty string must not blank the
// reference.
func TestSetInjectedImages(t *testing.T) {
	origAgent, origInit := activityAgentImage, permissionInitImage
	t.Cleanup(func() { activityAgentImage, permissionInitImage = origAgent, origInit })

	const (
		agentRef = "registry.example:5000/suanova/cubestack-activity-agent:v2.1.0"
		initRef  = "registry.example:5000/mirrors/docker.io/library/busybox:1.38.0"
	)

	t.Run("both overridden", func(t *testing.T) {
		activityAgentImage, permissionInitImage = origAgent, origInit
		SetInjectedImages(agentRef, initRef)
		if activityAgentImage != agentRef {
			t.Errorf("activityAgentImage = %q, want %q", activityAgentImage, agentRef)
		}
		if permissionInitImage != initRef {
			t.Errorf("permissionInitImage = %q, want %q", permissionInitImage, initRef)
		}
	})

	t.Run("empty arguments keep the defaults", func(t *testing.T) {
		activityAgentImage, permissionInitImage = origAgent, origInit
		SetInjectedImages("", "")
		if activityAgentImage != origAgent {
			t.Errorf("activityAgentImage = %q, want the default %q", activityAgentImage, origAgent)
		}
		if permissionInitImage != origInit {
			t.Errorf("permissionInitImage = %q, want the default %q", permissionInitImage, origInit)
		}
	})

	t.Run("one at a time", func(t *testing.T) {
		activityAgentImage, permissionInitImage = origAgent, origInit
		SetInjectedImages(agentRef, "")
		if activityAgentImage != agentRef {
			t.Errorf("activityAgentImage = %q, want %q", activityAgentImage, agentRef)
		}
		if permissionInitImage != origInit {
			t.Errorf("permissionInitImage = %q, want the default", permissionInitImage)
		}

		activityAgentImage = origAgent
		SetInjectedImages("", initRef)
		if permissionInitImage != initRef {
			t.Errorf("permissionInitImage = %q, want %q", permissionInitImage, initRef)
		}
		if activityAgentImage != origAgent {
			t.Errorf("activityAgentImage = %q, want the default", activityAgentImage)
		}
	})
}
