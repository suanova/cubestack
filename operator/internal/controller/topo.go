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

package controller

import (
	"fmt"

	aiv1alpha1 "github.com/suanova/cubestack/api/v1alpha1"
)

// topoOrder returns the role names in dependency order (dependencies first);
// an error when a DependsOn name does not resolve to a declared role or when
// the dependency graph has a cycle. The endpoint role moves to the end when
// nothing depends on it (design §5.1: the endpoint role updates last); when a
// role depends on it, the DAG order wins.
func topoOrder(roles []aiv1alpha1.Role, endpointRole string) ([]string, error) {
	known := make(map[string]bool, len(roles))
	for _, r := range roles {
		known[r.Name] = true
	}
	for _, r := range roles {
		for _, d := range r.DependsOn {
			if !known[d] {
				return nil, fmt.Errorf("role %q depends on unknown role %q", r.Name, d)
			}
		}
	}
	dependents := make(map[string][]string, len(roles)) // name → roles depending on it
	indegree := make(map[string]int, len(roles))
	dependedOn := make(map[string]bool)
	for _, r := range roles {
		indegree[r.Name] = len(r.DependsOn)
		for _, d := range r.DependsOn {
			dependents[d] = append(dependents[d], r.Name)
			dependedOn[d] = true
		}
	}
	queue := make([]string, 0, len(roles))
	for _, r := range roles {
		if indegree[r.Name] == 0 {
			queue = append(queue, r.Name)
		}
	}
	var order []string
	for len(queue) > 0 {
		name := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		if name == endpointRole && !dependedOn[name] && len(queue) > 0 {
			queue = append([]string{name}, queue...) // defer to the end
			continue
		}
		order = append(order, name)
		for _, dep := range dependents[name] {
			indegree[dep]--
			if indegree[dep] == 0 {
				queue = append(queue, dep)
			}
		}
	}
	if len(order) != len(roles) {
		return nil, fmt.Errorf("roles form a dependency cycle")
	}
	return order, nil
}
