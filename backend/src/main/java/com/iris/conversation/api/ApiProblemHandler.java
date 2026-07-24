package com.iris.conversation.api;

import com.iris.conversation.domain.ApiProblemException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.web.bind.support.WebExchangeBindException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.ServerWebInputException;

import java.net.URI;
import java.util.List;
import java.util.Map;

@RestControllerAdvice
public class ApiProblemHandler {

    @ExceptionHandler(ApiProblemException.class)
    public ProblemDetail handleApiProblem(
            ApiProblemException exception,
            ServerWebExchange exchange
    ) {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(
                exception.status(),
                exception.getMessage()
        );
        problem.setType(URI.create(
                "https://iris.local/problems/" + exception.code()
        ));
        problem.setTitle(exception.getMessage());
        problem.setProperty("code", exception.code());
        problem.setProperty("category", exception.category());
        problem.setProperty("traceId", exchange.getRequest().getId());
        problem.setProperty("context", exception.context());
        return problem;
    }

    @ExceptionHandler(WebExchangeBindException.class)
    public ProblemDetail handleValidation(
            WebExchangeBindException exception,
            ServerWebExchange exchange
    ) {
        List<Map<String, String>> fieldErrors = exception
                .getFieldErrors()
                .stream()
                .map(error -> Map.of(
                        "path", error.getField(),
                        "code", error.getCode() == null
                                ? "invalid"
                                : error.getCode(),
                        "message", error.getDefaultMessage() == null
                                ? "字段无效"
                                : error.getDefaultMessage()
                ))
                .toList();
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(
                HttpStatus.BAD_REQUEST,
                "请求字段无效。"
        );
        problem.setType(URI.create(
                "https://iris.local/problems/invalid-request"
        ));
        problem.setTitle("请求字段无效");
        problem.setProperty("code", "invalid_request");
        problem.setProperty("category", "validation");
        problem.setProperty("traceId", exchange.getRequest().getId());
        problem.setProperty("fieldErrors", fieldErrors);
        return problem;
    }

    @ExceptionHandler(ServerWebInputException.class)
    public ProblemDetail handleMalformedInput(
            ServerWebInputException exception,
            ServerWebExchange exchange
    ) {
        ProblemDetail problem = ProblemDetail.forStatusAndDetail(
                HttpStatus.BAD_REQUEST,
                "请求内容无法解析。"
        );
        problem.setType(URI.create(
                "https://iris.local/problems/invalid-request"
        ));
        problem.setTitle("请求内容无效");
        problem.setProperty("code", "invalid_request");
        problem.setProperty("category", "validation");
        problem.setProperty("traceId", exchange.getRequest().getId());
        return problem;
    }
}
