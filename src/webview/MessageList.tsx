import React, {memo} from "react";
import type {ChatMessage} from "../core/types";
import {VirtualRows} from "./VirtualRows";
import {Message} from "./Message";

export const MessageList = memo(function MessageList({messages}: {messages: ChatMessage[]}) {
  return <VirtualRows
    kind="message"
    items={messages}
    itemKey={message => message.id || `${message.role}-${message.timestamp}`}
    estimate={240}
    renderItem={message => <Message message={message} />}
  />;
});
