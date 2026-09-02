# TankTrouble Local

A local clone of the Tank Trouble game, with additional experimental gameplay modes and a custom dodging AI called **Vantage**.

## What is included

- A runnable offline Tank Trouble game core.
- Local guest/AI support and a small Python server for static files and local AJAX responses.
- Experimental training and benchmark tooling for testing bullet-dodging behavior.
- **Vantage**, a prediction-tree AI that evaluates tank operations against simulated projectile trajectories.
- The original readable JavaScript references used when modifying the packaged runtime.

## Quick start

Requirements:

- Python 3.7+
- A modern desktop browser

Run:

```bash
cd game_core
python server.py
```

Then open the URL printed by the server (normally <http://127.0.0.1:8000/>).

On Windows, you can also double-click:

```text
game_core/启动游戏.bat
```

Do not open `game_core/index.html` directly; browser CORS restrictions prevent its scripts and assets from loading.

## Repository layout

```text
game_core/        Runnable game core
  index.html      Game entry point
  server.py       Local HTTP/AJAX server
  js/             Runtime JavaScript and Vantage modules
  css/            Styles
  assets/         Game assets
  original_js/    Readable source references
  training_configs/
```

## Vantage

Vantage is the custom AI prototype in this repository. Its main modules are:

```text
game_core/js/vantage_sandbox.js   Physics sandbox and projectile simulation
game_core/js/vantage_scoring.js   Scoring, threat calculation, and rollout evaluation
game_core/js/vantage_tree.js      Prediction tree, route selection, and execution
game_core/js/ai_vantage.js        AI adapter
game_core/js/vantage_testbench.js Debug/test workbench
```

The debug workbench can pause the game, step frame-by-frame, inspect the prediction tree, and export diagnostics.

## License

The repository code is under the MIT license in `LICENSE`.

Tank Trouble assets and original game code belong to their respective owners. This project is intended for local study and experimentation; please do not redistribute the official assets commercially.
