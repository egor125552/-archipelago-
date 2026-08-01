from __future__ import annotations

import torch
from torch import nn


class TacticalPolicy(nn.Module):
    def __init__(self, input_size: int, hidden_size: int = 32, movement_classes: int = 5) -> None:
        super().__init__()
        self.input_size = input_size
        self.hidden_size = hidden_size
        self.movement_classes = movement_classes
        self.gru = nn.GRU(input_size, hidden_size, batch_first=True)
        self.movement_head = nn.Linear(hidden_size, movement_classes)
        self.fire_head = nn.Linear(hidden_size, 2)

    def forward(self, inputs: torch.Tensor, hidden: torch.Tensor | None = None):
        outputs, hidden = self.gru(inputs, hidden)
        return self.movement_head(outputs), self.fire_head(outputs), hidden
