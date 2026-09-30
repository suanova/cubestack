//go:build e2e
// +build e2e

/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package e2e

import (
	"fmt"
	"os"
	"os/exec"
	"testing"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/suanova/cubestack/test/e2e/devenv"
	"github.com/suanova/cubestack/test/utils"
)

var (
	// managerImage is the manager image to be built and loaded for testing.
	managerImage = "example.com/cubestack:v0.0.1"
	// shouldCleanupCertManager tracks whether CertManager was installed by this suite.
	shouldCleanupCertManager = false
)

// TestE2E runs the e2e test suite to validate the solution in an isolated environment.
// The default setup requires Kind and CertManager.
//
// To enable kubectl kuberc (use custom kubectl configurations), set: KUBECTL_KUBERC=true
// By default, kuberc is disabled to ensure consistent test behavior across different environments.
// To skip CertManager installation, set: CERT_MANAGER_INSTALL_SKIP=true
//
// To run the DevEnvironment conformance cases against an existing cluster instead,
// set DEVENV_E2E=1 and KUBECONFIG — see the devenv-e2e make target.
func TestE2E(t *testing.T) {
	RegisterFailHandler(Fail)
	_, _ = fmt.Fprintf(GinkgoWriter, "Starting cubestack e2e test suite\n")

	suiteConfig, reporterConfig := GinkgoConfiguration()
	if suiteConfig.LabelFilter == "" {
		// A run that named no filter gets this suite's historical scope, which is
		// the specs that build their own kind cluster. The conformance cases want a
		// cluster nobody here built and pull images measured in gigabytes, so
		// reaching them takes either a label filter or the devenv-e2e target —
		// forgetting one has to land on the cheap side.
		suiteConfig.LabelFilter = "!" + devenv.LabelConformance
	}
	RunSpecs(t, "e2e suite", suiteConfig, reporterConfig)
}

var _ = BeforeSuite(func() {
	if os.Getenv(envDevEnvConformance) == "1" {
		// The subject here is a cluster somebody else owns: the kind cluster, the
		// manager image and cert-manager all belong to the other path, and building
		// any of them would be building them for a cluster that is not being used.
		setupDevEnvConformance()
		return
	}

	verifyKindContext()

	By("building the manager image")
	cmd := exec.Command("make", "docker-build", fmt.Sprintf("IMG=%s", managerImage))
	_, err := utils.Run(cmd)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to build the manager image")

	// TODO(user): If you want to change the e2e test vendor from Kind,
	// ensure the image is built and available, then remove the following block.
	By("loading the manager image on Kind")
	err = utils.LoadImageToKindClusterWithName(managerImage)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to load the manager image into Kind")

	configureKubectlKubeRC()
	setupCertManager()
})

var _ = AfterSuite(func() {
	if os.Getenv(envDevEnvConformance) == "1" {
		// Teardown first, and unconditionally. The report fails when a run tested
		// two artifacts under one image name, and an Expect failure ends this
		// function where it stands — so a report placed first leaks the run's
		// namespace and every environment in it, which is exactly the run that is
		// already telling you something went wrong.
		teardownDevEnvConformance()
		reportDevEnvImageDigests()
		return
	}
	teardownCertManager()
})

// kindClusterName returns the Kind cluster name used by the e2e tests.
// It mirrors the KIND_CLUSTER default in operator/Makefile.
func kindClusterName() string {
	if name := os.Getenv("KIND_CLUSTER"); name != "" {
		return name
	}
	return "cubestack-test-e2e"
}

// verifyKindContext ensures the active kubectl context targets the dedicated Kind cluster
// before any destructive setup (CRD install, namespace creation, deployment) runs,
// so the tests can never touch a real development or production cluster.
func verifyKindContext() {
	By("verifying the active kubectl context targets the Kind cluster")
	cmd := exec.Command("kubectl", "config", "current-context")
	output, err := utils.Run(cmd)
	ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to get the active kubectl context")
	expected := fmt.Sprintf("kind-%s", kindClusterName())
	ExpectWithOffset(1, utils.ContextEquals(output, expected)).To(BeTrue(),
		"e2e tests must run against the dedicated Kind cluster %q, got %q", expected, output)
}

// Disable kubectl kuberc by default for test isolation.
// This prevents local kubectl configurations from affecting test behavior.
// To enable kuberc, set: KUBECTL_KUBERC=true
func configureKubectlKubeRC() {
	if os.Getenv("KUBECTL_KUBERC") != "true" {
		By("disabling kubectl kuberc for test isolation")
		err := os.Setenv("KUBECTL_KUBERC", "false")
		ExpectWithOffset(1, err).NotTo(HaveOccurred(), "Failed to disable kubectl kuberc")
		_, _ = fmt.Fprintf(GinkgoWriter,
			"kubectl kuberc disabled for consistent test behavior (override with KUBECTL_KUBERC=true)\n")
	} else {
		_, _ = fmt.Fprintf(GinkgoWriter, "kubectl kuberc enabled (KUBECTL_KUBERC=true)\n")
	}
}

// setupCertManager installs CertManager if needed for webhook tests.
// Skips installation if CERT_MANAGER_INSTALL_SKIP=true or if already present.
func setupCertManager() {
	if os.Getenv("CERT_MANAGER_INSTALL_SKIP") == "true" {
		_, _ = fmt.Fprintf(GinkgoWriter, "Skipping CertManager installation (CERT_MANAGER_INSTALL_SKIP=true)\n")
		return
	}

	By("checking if CertManager is already installed")
	if utils.IsCertManagerCRDsInstalled() {
		_, _ = fmt.Fprintf(GinkgoWriter, "CertManager is already installed. Skipping installation.\n")
		return
	}

	// Mark for cleanup before installation to handle interruptions and partial installs.
	shouldCleanupCertManager = true

	By("installing CertManager")
	Expect(utils.InstallCertManager()).To(Succeed(), "Failed to install CertManager")
}

// teardownCertManager uninstalls CertManager if it was installed by setupCertManager.
// This ensures we only remove what we installed.
func teardownCertManager() {
	if !shouldCleanupCertManager {
		_, _ = fmt.Fprintf(GinkgoWriter, "Skipping CertManager cleanup (not installed by this suite)\n")
		return
	}

	By("uninstalling CertManager")
	utils.UninstallCertManager()
}
