# SPDX-FileCopyrightText: 2025-2026 Forschungszentrum Jülich GmbH (IAS-9) and HKG contributors
# SPDX-License-Identifier: MIT
"""HTTP error dialect for QLever failures (cards B2-B7).

Every endpoint card funnels :class:`app.qlever.QleverError` through
:func:`qlever_error_response`, so clients see one stable mapping:

- ``400`` — :class:`QleverQueryError`: the SPARQL itself was rejected
  (parser); the detail carries the endpoint's message.
- ``429`` — :class:`QleverRateLimited`: shared-token penalty; the
  ``Retry-After`` header carries the server-declared wait (the 60s..3600s
  ladder, clamped in the client). The API never sleeps out the wait.
- ``502`` — :class:`QleverServerError`: endpoint 5xx / non-JSON 2xx.
- ``503`` — :class:`QleverUnavailable`: timeout or connection failure.
"""

from __future__ import annotations

import math

from fastapi.responses import JSONResponse

from app.qlever import (
    QleverError,
    QleverQueryError,
    QleverRateLimited,
    QleverServerError,
    QleverUnavailable,
)


def qlever_error_response(exc: QleverError) -> JSONResponse:
    """Map a QLever failure to the endpoint error dialect (see module doc)."""
    if isinstance(exc, QleverQueryError):
        return JSONResponse(status_code=400, content={"detail": str(exc)})
    if isinstance(exc, QleverRateLimited):
        return JSONResponse(
            status_code=429,
            content={"detail": str(exc)},
            headers={"Retry-After": str(math.ceil(exc.wait_s))},
        )
    if isinstance(exc, QleverUnavailable):
        return JSONResponse(status_code=503, content={"detail": str(exc)})
    if isinstance(exc, QleverServerError):
        return JSONResponse(status_code=502, content={"detail": str(exc)})
    return JSONResponse(status_code=502, content={"detail": str(exc)})
