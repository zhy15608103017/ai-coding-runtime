# OpenAI-Compatible Worker Schema Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix worker execution against OpenAI-compatible gateways that reject the current strict JSON schema used for `runtime_execute`.

**Architecture:** Keep the fix narrow. Add a regression test around the request shape used for worker execution, then change the execution path so OpenAI-compatible worker calls avoid the incompatible structured response schema while preserving JSON-only prompting and existing result parsing.

**Tech Stack:** Node.js, node:test, existing runtime execution/provider modules

---