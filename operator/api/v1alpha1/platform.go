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

package v1alpha1

// S3 credentials contract of the platform (design §3.1 S3 strategy, §4.5):
// the source credentials Secret is copied into the service namespace and
// mounted so that a single file — ModelCredentialsFilePath — always exists
// for roles referencing {{ model.credentialsPath }}. The content format is
// owned by the platform admin and the engine contract; the platform only
// pins the key and the file layout.
const (
	// ModelCredentialsDir is the volume mount path of the S3 credentials copy.
	ModelCredentialsDir = "/var/run/cubestack"

	// ModelCredentialsFile is the single file name the credentials key is
	// mapped to inside ModelCredentialsDir (volumeMount items path).
	ModelCredentialsFile = "model-credentials"

	// ModelCredentialsFilePath is the fixed file path of the S3 credentials,
	// the value of {{ model.credentialsPath }}.
	ModelCredentialsFilePath = ModelCredentialsDir + "/" + ModelCredentialsFile

	// ModelCredentialsKey is the single data key contract of the source
	// credentials Secret; the copy must carry it for the mount to succeed.
	ModelCredentialsKey = "credentials"
)
