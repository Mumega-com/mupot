#!/usr/bin/env python3
"""Tests for crew-assembler (MU.100.003 crew model).

Coverage:
  - Labor pools correctly (cheapest-capable wins)
  - Authority is never pooled (sealed seat or fail)
  - UUID-match (by agent_id, not slug)
  - UNSATISFIABLE on missing token/ability
  - Resource validation
"""
from __future__ import annotations

import tempfile
from pathlib import Path
import pytest
import yaml

from crew_assembler import (
    AgentProfile,
    AssemblyError,
    BoundCrew,
    assemble,
    load_profiles,
    resolve_authority_seat,
    resolve_labor_role,
)


@pytest.fixture
def temp_profiles_dir():
    """Create a temporary directory for test profiles."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def sample_profiles(temp_profiles_dir):
    """Create sample agent profiles for testing."""
    profiles = {
        # Expensive builder (Opus)
        'kasra-profile': {
            'agent': 'kasra',
            'agent_id': 'c855f82c-1eeb-409d-94d2-f11e9dd18968',
            'harness': 'claude-code',
            'models': ['claude-opus-5'],
            'status': 'live',
            'tokens': ['mupot-admin', 'gh', 'bus'],
            'abilities': ['build-python', 'build-ts', 'git', 'gate-correctness'],
            'authority': ['merge-authority'],
            'subagents': {'kasra-code': ['build-python', 'build-ts']},
            'availability': 'live',
        },
        # Cheap builder (Deepseek)
        'asha-profile': {
            'agent': 'asha',
            'agent_id': 'e211b0fb-6ebf-4aab-bac5-6129ce6075e0',
            'harness': 'prime-headless',
            'models': ['deepseek-v4-flash'],
            'status': 'live',
            'tokens': ['mupot-admin'],
            'abilities': ['build-python', 'evidence-gate', 'coherency-sweep'],
            'authority': ['first-pass-gate'],
            'subagents': {'asha-core': ['build-python']},
            'availability': 'live',
        },
        # Authority seat holder (loom as protocol custodian)
        'loom-profile': {
            'agent': 'loom',
            'agent_id': '118c976c-7f51-4d6a-a462-04f4ddf6cc05',
            'harness': 'codex-cli',
            'models': ['gpt-5.4'],
            'status': 'live',
            'tokens': ['mupot-admin', 'bus'],
            'abilities': ['protocol-operations'],
            'authority': ['protocol-custodian', 'qnft-witness'],
            'subagents': {'loom-core': ['protocol-operations']},
            'availability': 'live',
        },
        # Reserved agent (river)
        'river-profile': {
            'agent': 'river',
            'agent_id': 'f23a6c2c-1234-4567-a890-bcdef0123456',
            'harness': 'agy',
            'models': ['gemini-3.6-flash'],
            'status': 'reserve',
            'tokens': ['mupot-admin', 'bus'],
            'abilities': ['frc-operations', 'content-generation'],
            'authority': ['witness', 'frc-keeper'],
            'subagents': {'river-code': ['code']},
            'availability': 'offline',
        },
        # Limited channel agent (mubot)
        'mubot-profile': {
            'agent': 'mubot',
            'agent_id': 'd3fd65b6-1234-4567-a890-bcdef0123456',
            'harness': 'telegram-bot',
            'models': ['deepseek-v4-flash'],
            'status': 'live',
            'tokens': ['telegram-channel'],
            'abilities': ['customer-face', 'reflect'],
            'authority': [],
            'subagents': {'mubot-core': ['customer-face']},
            'availability': 'live',
        },
    }

    for name, spec in profiles.items():
        profile_file = temp_profiles_dir / f"{spec['agent']}.yaml"
        with open(profile_file, 'w') as f:
            yaml.dump(spec, f)

    return temp_profiles_dir


class TestAgentProfile:
    """Tests for AgentProfile class."""

    def test_load_from_yaml(self, sample_profiles):
        """Load a profile from YAML."""
        profile = AgentProfile.from_yaml(sample_profiles / 'kasra.yaml')
        assert profile.agent == 'kasra'
        assert profile.agent_id == 'c855f82c-1eeb-409d-94d2-f11e9dd18968'
        assert profile.status == 'live'
        assert 'merge-authority' in profile.authority

    def test_is_available_live(self, sample_profiles):
        """Live + available agent is crewable."""
        profile = AgentProfile.from_yaml(sample_profiles / 'kasra.yaml')
        assert profile.is_available() is True

    def test_is_not_available_reserve(self, sample_profiles):
        """Reserved + offline agent is not crewable."""
        profile = AgentProfile.from_yaml(sample_profiles / 'river.yaml')
        assert profile.is_available() is False

    def test_can_do(self, sample_profiles):
        """Check ability matching."""
        kasra = AgentProfile.from_yaml(sample_profiles / 'kasra.yaml')
        assert kasra.can_do(['build-python']) is True
        assert kasra.can_do(['build-python', 'git']) is True
        assert kasra.can_do(['wp-build']) is False

    def test_has_tokens(self, sample_profiles):
        """Check token matching."""
        kasra = AgentProfile.from_yaml(sample_profiles / 'kasra.yaml')
        assert kasra.has_tokens(['mupot-admin']) is True
        assert kasra.has_tokens(['mupot-admin', 'gh']) is True
        assert kasra.has_tokens(['r2-write']) is False

    def test_matches_harness_any(self, sample_profiles):
        """Unspecified harness matches any agent."""
        kasra = AgentProfile.from_yaml(sample_profiles / 'kasra.yaml')
        assert kasra.matches_harness(None) is True

    def test_matches_harness_specific(self, sample_profiles):
        """Specific harness must match exactly."""
        kasra = AgentProfile.from_yaml(sample_profiles / 'kasra.yaml')
        assert kasra.matches_harness('claude-code') is True
        assert kasra.matches_harness('prime-headless') is False

    def test_model_tier_rank_opus(self, sample_profiles):
        """Opus is most expensive (highest tier number)."""
        kasra = AgentProfile.from_yaml(sample_profiles / 'kasra.yaml')
        assert kasra.model_tier_rank() == 10

    def test_model_tier_rank_deepseek(self, sample_profiles):
        """Deepseek is cheaper than Opus (lower tier number)."""
        asha = AgentProfile.from_yaml(sample_profiles / 'asha.yaml')
        kasra = AgentProfile.from_yaml(sample_profiles / 'kasra.yaml')
        assert asha.model_tier_rank() < kasra.model_tier_rank()


class TestLoadProfiles:
    """Tests for profile loading."""

    def test_load_all_profiles(self, sample_profiles):
        """Load all profiles from directory."""
        profiles = load_profiles(sample_profiles)
        assert len(profiles) == 5
        assert 'c855f82c-1eeb-409d-94d2-f11e9dd18968' in profiles  # kasra
        assert 'e211b0fb-6ebf-4aab-bac5-6129ce6075e0' in profiles  # asha


class TestResolveAuthoritySeat:
    """Tests for authority seat resolution."""

    def test_resolve_authority_found(self, sample_profiles):
        """Resolve a held authority seat."""
        profiles = load_profiles(sample_profiles)
        agent_id = resolve_authority_seat('merge-authority', profiles)
        assert agent_id == 'c855f82c-1eeb-409d-94d2-f11e9dd18968'  # kasra

    def test_resolve_authority_not_found(self, sample_profiles):
        """UNSATISFIABLE: seat not held by anyone."""
        profiles = load_profiles(sample_profiles)
        with pytest.raises(AssemblyError, match="authority seat.*not held"):
            resolve_authority_seat('nonexistent-seat', profiles)

    def test_resolve_authority_holder_unavailable(self, sample_profiles):
        """UNSATISFIABLE: seat holder is offline."""
        profiles = load_profiles(sample_profiles)
        # witness is held by river, which is reserve + offline
        with pytest.raises(AssemblyError, match="not available"):
            resolve_authority_seat('witness', profiles)

    def test_authority_never_pooled_loom_qnft(self, sample_profiles):
        """Authority seat is bound to the exact holder (loom for qnft-witness)."""
        profiles = load_profiles(sample_profiles)
        # loom holds qnft-witness; should bind to loom, not anyone else
        agent_id = resolve_authority_seat('qnft-witness', profiles)
        assert profiles[agent_id].agent == 'loom'


class TestResolveLaborRole:
    """Tests for labor role resolution."""

    def test_cheapest_capable_wins(self, sample_profiles):
        """Cheapest-capable agent is bound for labor roles."""
        profiles = load_profiles(sample_profiles)
        needs = {'abilities': ['build-python'], 'tokens': ['mupot-admin']}
        bound_id, standby_ids = resolve_labor_role('builder', needs, profiles)

        # asha (deepseek) should win over kasra (opus) — cheaper
        assert profiles[bound_id].agent == 'asha'
        assert len(standby_ids) > 0
        assert 'c855f82c-1eeb-409d-94d2-f11e9dd18968' in standby_ids  # kasra in standby

    def test_unsatisfiable_missing_ability(self, sample_profiles):
        """UNSATISFIABLE: no agent has required ability."""
        profiles = load_profiles(sample_profiles)
        needs = {'abilities': ['wp-build'], 'tokens': ['mupot-admin']}
        with pytest.raises(AssemblyError, match="no available agent matches"):
            resolve_labor_role('builder', needs, profiles)

    def test_unsatisfiable_missing_token(self, sample_profiles):
        """UNSATISFIABLE: no agent has required token."""
        profiles = load_profiles(sample_profiles)
        needs = {'abilities': ['build-python'], 'tokens': ['r2-write']}
        with pytest.raises(AssemblyError, match="no available agent matches"):
            resolve_labor_role('builder', needs, profiles)

    def test_harness_match_required(self, sample_profiles):
        """Harness filtering works."""
        profiles = load_profiles(sample_profiles)
        needs = {
            'abilities': ['build-python'],
            'tokens': ['mupot-admin'],
            'harness': 'prime-headless',
        }
        bound_id, _ = resolve_labor_role('builder', needs, profiles)
        assert profiles[bound_id].harness == 'prime-headless'

    def test_standby_pool_populated(self, sample_profiles):
        """Multiple candidates populate standby pool."""
        profiles = load_profiles(sample_profiles)
        needs = {'abilities': ['build-python'], 'tokens': ['mupot-admin']}
        bound_id, standby_ids = resolve_labor_role('builder', needs, profiles)

        # Both asha and kasra can do it; one bound, one standby
        assert len(standby_ids) > 0


class TestAssemble:
    """Integration tests for crew assembly."""

    def test_assemble_simple_crew(self, sample_profiles):
        """Assemble a simple crew with one labor role."""
        manifest = {
            'crew': [
                {
                    'role': 'builder',
                    'needs': {'abilities': ['build-python'], 'tokens': ['mupot-admin']},
                }
            ]
        }
        result = assemble(manifest, sample_profiles)
        assert isinstance(result, BoundCrew)
        assert 'builder' in result.bound
        assert result.bound['builder']['agent'] == 'asha'  # cheapest-capable

    def test_assemble_with_authority(self, sample_profiles):
        """Assemble crew with both labor and authority roles."""
        manifest = {
            'crew': [
                {
                    'role': 'builder',
                    'needs': {'abilities': ['build-python'], 'tokens': ['mupot-admin']},
                },
                {
                    'role': 'gatekeeper',
                    'needs': {'abilities': ['gate-correctness']},
                    'authority': 'merge-authority',
                },
            ]
        }
        result = assemble(manifest, sample_profiles)
        assert result.bound['builder']['agent'] == 'asha'
        assert result.bound['gatekeeper']['agent'] == 'kasra'

    def test_assemble_authority_never_pooled(self, sample_profiles):
        """Authority roles are never pooled; one specific agent or FAIL."""
        manifest = {
            'crew': [
                {
                    'role': 'gatekeeper',
                    'authority': 'merge-authority',
                }
            ]
        }
        result = assemble(manifest, sample_profiles)
        # merge-authority is held by kasra only
        assert result.bound['gatekeeper']['agent'] == 'kasra'
        assert result.standby['gatekeeper'] == []  # No standby for authority

    def test_unsatisfiable_authority_unavailable(self, sample_profiles):
        """UNSATISFIABLE: authority seat holder is offline."""
        manifest = {
            'crew': [
                {
                    'role': 'witness_gate',
                    'authority': 'witness',  # held by river (offline)
                }
            ]
        }
        with pytest.raises(AssemblyError, match="not available"):
            assemble(manifest, sample_profiles)

    def test_unsatisfiable_labor_role(self, sample_profiles):
        """UNSATISFIABLE: no agent matches labor role needs."""
        manifest = {
            'crew': [
                {
                    'role': 'wordpress_builder',
                    'needs': {'abilities': ['wp-build'], 'tokens': ['mupot-admin']},
                }
            ]
        }
        with pytest.raises(AssemblyError, match="no available agent matches"):
            assemble(manifest, sample_profiles)

    def test_resource_validation_passes(self, sample_profiles):
        """Resource validation: all required resources held by someone."""
        manifest = {
            'crew': [
                {
                    'role': 'builder',
                    'needs': {'abilities': ['build-python'], 'tokens': ['mupot-admin']},
                }
            ],
            'resources': ['gh', 'bus'],  # both held by kasra or asha+kasra
        }
        result = assemble(manifest, sample_profiles)
        assert isinstance(result, BoundCrew)

    def test_resource_validation_fails(self, sample_profiles):
        """UNSATISFIABLE: required resource not held by anyone."""
        manifest = {
            'crew': [
                {
                    'role': 'builder',
                    'needs': {'abilities': ['build-python'], 'tokens': ['mupot-admin']},
                }
            ],
            'resources': ['r2-write'],  # nobody has this
        }
        with pytest.raises(AssemblyError, match="not held by any available agent"):
            assemble(manifest, sample_profiles)

    def test_match_by_uuid_not_slug(self, sample_profiles):
        """Matching is by agent_id (UUID), never by slug."""
        profiles = load_profiles(sample_profiles)
        # All profiles loaded keyed by agent_id (UUID), not slug
        for agent_id in profiles:
            assert '-' in agent_id  # UUID format
            # Verify agent_id is never a slug like 'kasra' or 'asha'
            assert agent_id not in ('kasra', 'asha', 'loom', 'river', 'mubot')


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
