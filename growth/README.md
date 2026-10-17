# Growth operations

This directory turns the path to 1,000 stars into a dated, measurable campaign without turning the project into a spam bot. It automates planning, public-project discovery, qualification hints, draft generation, opt-in onboarding, reminders, and GitHub metrics. A maintainer remains responsible for publishing, community participation, releases, claims, and all person-to-person outreach.

The campaign starts on **2026-09-21**. Change `start_date`, `product_name`, repository fields, and targets in `config.json` before enabling scheduled workflows—especially after a rename. Dates are generated from day offsets, so the whole calendar moves with one field.

## One-command heartbeat

```sh
python3 scripts/growth.py heartbeat --with-metrics
```

That is the single entrypoint for a daily Codex heartbeat. It validates the campaign, lists the next 72 hours, identifies due drafts, repeats the approval boundary, and optionally reads live GitHub metrics. It does not mutate GitHub or contact anyone.

Other useful commands:

```sh
python3 scripts/growth.py validate
python3 scripts/growth.py calendar
python3 scripts/growth.py weekly
python3 scripts/growth.py content --id show-hn
python3 scripts/growth.py discover
python3 scripts/growth.py metrics
```

`GITHUB_TOKEN` is optional locally. When it is absent, the script uses the token from an authenticated GitHub CLI if available. GitHub Actions supplies its own token; there are no paid services or custom secrets.

## How to recruit Founding Operators

The realistic route to 15–25 design partners is a small opt-in funnel, not cold outreach:

1. Put one concrete call for Founding Operators in the README, release notes, demo, and project-owned social profile. Link to the issue form. Do not require a star, post, quote, or endorsement.
2. Offer something scarce and useful: hands-on installation help, a fast bug-response window, influence over the compatibility matrix, and a private-by-default workflow review.
3. Qualify for the problem, not audience size. Prioritize applicants using multiple agents or machines weekly who can test with disposable work and commit to two short feedback loops.
4. Get to first value asynchronously. The automated acknowledgment gives the safe-install checklist; a maintainer confirms fit and opens a bounded onboarding window.
5. Ask for proof only after value exists. At week two, ask whether the operator would approve an anonymized outcome. Attribution, screenshots, quotes, and case studies require separate written approval.
6. Turn repeated friction into public contributor tasks. Invite an operator to contribute only when they have already expressed interest; a maintainer supplies scope, fixtures, and review support.

Good recruiting surfaces are your repository, launch posts people chose to read, open installation office hours, existing users' opt-in demonstrations, and direct replies to people who explicitly ask for a solution. Do not scrape emails, mass-open issues in adjacent repositories, auto-DM stargazers, or treat a public GitHub profile as consent.

### Funnel definitions

| Stage | Definition | 90-day target |
|---|---|---:|
| Applicant | Submitted the Founding Operator form | 40 |
| Qualified | Has the problem, can test safely, accepts the feedback loop | 25 |
| Installed | Completed verification on a disposable setup | 15 |
| Weekly active | Used the product in two separate weeks | 10 |
| Proof approved | Approved an anonymized outcome or case study | 5 |

Track these weekly in the generated growth brief. GitHub cannot infer successful installs or weekly use honestly, so those two fields require a maintainer or an explicit opt-in telemetry mechanism. Do not label guesses as users.

The structured campaign baseline and later verified snapshots live in `metrics-history.json`. Use `null` for funnel values that have no verified source; never turn missing data into a zero. GitHub traffic and clone counts are rolling 14-day measurements, so the day-one snapshot may include pre-campaign activity.

## Automation boundary

| Surface | Discover/measure | Generate draft | Publish or contact | Gate |
|---|---|---|---|---|
| Repository metrics/dashboard | Automatic | Automatic | Automatic update to one operational issue | No marketing claims |
| Daily/weekly planning issue | Automatic | Automatic | Automatic update to one repository issue | Maintainer checks completion boxes |
| Founding Operator application | User initiated | Automatic static acknowledgment | Automatic reply to that applicant only | Opt-in form is the consent event |
| README/docs/product screenshots | Automatic reminder | Automatic scaffold | Pull request or merge by maintainer | Tests and human review |
| GitHub release | Automatic reminder | Automatic draft | Manual publish | Verification and maintainer approval |
| Project-owned blog/social/newsletter | Automatic reminder | Automatic draft | Manual publish | Claim, consent, link, and timing review |
| Hacker News, Reddit, Discord, forums | Public-rule discovery only | Automatic channel-specific draft | **Never automatic** | Human reads rules, submits, and replies |
| Curated directories | Directory discovery only | Automatic submission draft | **Never automatic** | Human checks fit and contribution rules |
| Adjacent open-source projects | Public metadata discovery | Automatic qualification report | **Never automatic** | No unsolicited issue, PR, email, or DM |
| Interviews and case studies | Application metrics only | Automatic outline | Human conversation and approval | Separate written publication consent |

The `growth-heartbeat.yml` workflow updates a single operational issue and the Actions summary each day. `growth-discovery.yml` writes its public-project research to the Actions summary and an artifact; only manual dispatch with `create_issue=true` may copy it into a repository issue. Neither workflow can publish elsewhere.

## Operating cadence

- Daily: read the heartbeat, unblock opted-in applicants, and update human-owned status checkboxes.
- Monday: review the generated weekly brief and activation funnel.
- Wednesday: review drafts due within seven days; discard weak or repetitive ones.
- Friday: review metrics and decide whether to improve conversion or continue distribution.
- Every launch: be present for replies, log the recurring questions, and update the product/docs before cross-posting.
- Every two weeks: interview active operators and close the loop on earlier feedback.

Pause launch activity if installation is unreliable, the queue contains unsupported claims, support response exceeds two working days, or community feedback says the posting cadence is unwelcome.

## Files

- `config.json`: dates, targets, search queries, and non-negotiable rules.
- `schedule.json`: the complete 90-day milestone plan.
- `content-queue.json`: channel-specific stories, states, and templates.
- `metrics-history.json`: dated repository and verified funnel snapshots, beginning with the day-one baseline.
- `templates/`: drafts with visible TODOs and approval checklists.
- `.github/ISSUE_TEMPLATE/founding-operator.yml`: opt-in application.
- `.github/workflows/growth-*.yml`: scheduled, repository-native operations.

The configuration is JSON so the automation can run with Python's standard library and no package install.
