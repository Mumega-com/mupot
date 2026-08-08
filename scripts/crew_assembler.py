#!/usr/bin/env python3
"""Crew-assembler — resolve flight crew from capability profiles.

Part of MU.100.003 (crew model). Reads a flight's crew requirements manifest and
the agent capability profiles; emits a bound crew or UNSATISFIABLE.

Rules (§6 of crew-model.md):
  1. Match by agent_id (UUID), never slug — registry drift is live
  2. Never pool an authority role — resolve the sealed seat or fail
  3. Availability is read at pre-flight, not assumed
  4. Fail loud on UNSATISFIABLE — no silent degrade
  5. Cheapest-capable wins for labor (model tier)
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional
import yaml


class AssemblyError(Exception):
    """Crew assembly failed — manifest cannot be satisfied."""
    pass


@dataclass
class AgentProfile:
    """Parsed capability profile of an agent."""
    agent: str
    agent_id: str
    harness: str
    models: list[str]
    status: str
    tokens: list[str]
    abilities: list[str]
    authority: list[str]
    subagents: dict[str, list[str]]
    availability: str

    @classmethod
    def from_yaml(cls, path: Path) -> AgentProfile:
        """Load and parse a capability profile YAML file."""
        with open(path) as f:
            data = yaml.safe_load(f)
        return cls(
            agent=data.get('agent', ''),
            agent_id=data.get('agent_id', ''),
            harness=data.get('harness', ''),
            models=data.get('models', []),
            status=data.get('status', ''),
            tokens=data.get('tokens', []),
            abilities=data.get('abilities', []),
            authority=data.get('authority', []),
            subagents=data.get('subagents', {}),
            availability=data.get('availability', ''),
        )

    def is_available(self) -> bool:
        """Agent is crewable: must be live and available."""
        return self.status == 'live' and self.availability in ('live', 'busy')

    def can_do(self, needed_abilities: list[str]) -> bool:
        """Agent has all needed abilities."""
        return all(a in self.abilities for a in needed_abilities)

    def has_tokens(self, needed_tokens: list[str]) -> bool:
        """Agent holds all needed tokens."""
        return all(t in self.tokens for t in needed_tokens)

    def matches_harness(self, required_harness: Optional[str]) -> bool:
        """Agent matches required harness (or harness is unspecified)."""
        if required_harness is None:
            return True
        return self.harness == required_harness

    def model_tier_rank(self) -> int:
        """Rank for cheapest-capable selection. Lower = cheaper (preferred)."""
        model = self.models[0] if self.models else "unknown"
        # Tier rankings (lower = cheaper, higher = more capable/expensive)
        tiers = {
            "deepseek-v4-flash": 1,   # Cheapest
            "gemini-3.6-flash": 2,
            "llama-3.3": 3,
            "hermes": 3,
            "gpt-5.4": 4,
            "claude-sonnet-5": 9,
            "claude-opus-5": 10,      # Most capable, most expensive
        }
        return tiers.get(model, 99)  # Unknown models are expensive


@dataclass
class CrewRole:
    """One crew role requirement in a flight manifest."""
    role: str
    needs: dict[str, Any]  # {abilities, tokens, harness?}
    authority: Optional[str] = None  # qNFT-sealed seat name


@dataclass
class BoundCrew:
    """Assembled crew for a flight."""
    bound: dict[str, dict[str, Any]]  # {role_name: {agent_id, agent, harness, model}}
    standby: dict[str, list[dict[str, Any]]]  # {role_name: [{agent_id, agent, model}, ...]}


def load_profiles(profiles_dir: Path) -> dict[str, AgentProfile]:
    """Load all capability profiles from a directory."""
    profiles = {}
    for yaml_file in profiles_dir.glob("*.yaml"):
        profile = AgentProfile.from_yaml(yaml_file)
        profiles[profile.agent_id] = profile
    return profiles


def resolve_authority_seat(
    authority_name: str,
    profiles: dict[str, AgentProfile],
) -> str:
    """Resolve a sealed authority seat to an agent_id.

    Authority seats are qNFT-sealed and not poolable. This function finds the
    single agent that holds the given authority.

    Raises AssemblyError if the seat is not held or the holder is unavailable.
    """
    matches = [
        pid for pid, prof in profiles.items()
        if authority_name in prof.authority
    ]

    if not matches:
        raise AssemblyError(
            f"UNSATISFIABLE: authority seat '{authority_name}' is not held by any agent"
        )

    if len(matches) > 1:
        raise AssemblyError(
            f"UNSATISFIABLE: authority seat '{authority_name}' held by multiple agents "
            f"(data corruption: {matches})"
        )

    agent_id = matches[0]
    prof = profiles[agent_id]

    if not prof.is_available():
        raise AssemblyError(
            f"UNSATISFIABLE: authority seat '{authority_name}' holder {prof.agent} "
            f"(id={agent_id}) is not available (status={prof.status}, availability={prof.availability})"
        )

    return agent_id


def resolve_labor_role(
    role_name: str,
    needs: dict[str, Any],
    profiles: dict[str, AgentProfile],
) -> tuple[str, list[str]]:
    """Resolve a labor role to the best available agent.

    Returns (bound_agent_id, standby_agent_ids).
    The bound agent is cheapest-capable; others go STANDBY.

    Raises AssemblyError if no agent can satisfy the role.
    """
    required_abilities = needs.get('abilities', [])
    required_tokens = needs.get('tokens', [])
    required_harness = needs.get('harness')

    candidates = [
        (pid, prof)
        for pid, prof in profiles.items()
        if prof.is_available()
        and prof.can_do(required_abilities)
        and prof.has_tokens(required_tokens)
        and prof.matches_harness(required_harness)
    ]

    if not candidates:
        raise AssemblyError(
            f"UNSATISFIABLE: role '{role_name}' needs abilities {required_abilities}, "
            f"tokens {required_tokens}, harness {required_harness}; no available agent matches"
        )

    # Sort by model tier (cheapest first), then by agent_id for determinism
    candidates.sort(key=lambda x: (x[1].model_tier_rank(), x[0]))

    bound_id = candidates[0][0]
    standby_ids = [cid for cid, _ in candidates[1:]]

    return bound_id, standby_ids


def assemble(
    flight_requires: dict[str, Any],
    profiles_dir: Path,
) -> BoundCrew:
    """Assemble a crew from flight requirements.

    Args:
        flight_requires: Dict with 'crew' list (each item: {role, needs, authority?})
        profiles_dir: Directory containing agent capability profiles (*.yaml)

    Returns:
        BoundCrew with bound roles and standby pools

    Raises:
        AssemblyError: If the crew cannot be assembled (UNSATISFIABLE)
    """
    profiles = load_profiles(profiles_dir)
    if not profiles:
        raise AssemblyError(f"UNSATISFIABLE: no profiles found in {profiles_dir}")

    bound = {}
    standby = {}

    crew_roles = flight_requires.get('crew', [])
    for role_spec in crew_roles:
        role_name = role_spec.get('role')
        needs = role_spec.get('needs', {})
        authority_seat = role_spec.get('authority')

        if authority_seat:
            # Authority role — must bind the sealed seat, never pool
            agent_id = resolve_authority_seat(authority_seat, profiles)
            prof = profiles[agent_id]
            bound[role_name] = {
                'agent_id': agent_id,
                'agent': prof.agent,
                'harness': prof.harness,
                'model': prof.models[0] if prof.models else None,
            }
            standby[role_name] = []
        else:
            # Labor role — bind cheapest-capable, standby the rest
            bound_id, standby_ids = resolve_labor_role(role_name, needs, profiles)
            prof = profiles[bound_id]
            bound[role_name] = {
                'agent_id': bound_id,
                'agent': prof.agent,
                'harness': prof.harness,
                'model': prof.models[0] if prof.models else None,
            }
            standby[role_name] = [
                {
                    'agent_id': sid,
                    'agent': profiles[sid].agent,
                    'model': profiles[sid].models[0] if profiles[sid].models else None,
                }
                for sid in standby_ids
            ]

    # Verify resources (if any) — all required tokens must be held by someone
    resources = flight_requires.get('resources', [])
    for resource in resources:
        holders = [
            prof.agent for prof in profiles.values()
            if resource in prof.tokens and prof.is_available()
        ]
        if not holders:
            raise AssemblyError(
                f"UNSATISFIABLE: resource '{resource}' is not held by any available agent"
            )

    return BoundCrew(bound=bound, standby=standby)


if __name__ == '__main__':
    # Example usage / smoke test
    if len(sys.argv) < 2:
        print("Usage: crew_assembler.py <profiles_dir> [manifest_file.yaml]")
        sys.exit(1)

    profiles_dir = Path(sys.argv[1])
    manifest_file = Path(sys.argv[2]) if len(sys.argv) > 2 else None

    # If no manifest provided, just list available agents
    try:
        profiles = load_profiles(profiles_dir)
        print(f"Loaded {len(profiles)} agent profiles:")
        for agent_id, prof in sorted(profiles.items()):
            print(f"  {prof.agent:20s} {agent_id:36s} {prof.status:8s} {prof.availability:8s}")
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
